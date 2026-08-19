/**
 * Audit (FR-070..FR-073).
 *
 * `writeAudit` is the only way an audit event is created. It also marks the
 * request as having audited, which lets `registerAuditCompletenessCheck` turn
 * "a handler without an audit call is an incomplete handler" into something the
 * runtime notices rather than something review has to catch.
 *
 * A failed audit write fails the surrounding transaction. An action that
 * happened but was not recorded is worse than an action that did not happen.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditKind, Principal } from '@spendifre/shared';
import type { ServedScope } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { identifier, join, sql, type SqlFragment } from '../db/pool.ts';
import { auditFailures } from '../observability/metrics.ts';
import { servedEntityClause } from './residency.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auditWrites: number;
  }
}

export interface AuditInput {
  actor: Pick<Principal, 'userId' | 'role'>;
  action: string;
  targetType: string;
  targetId?: string | null;
  entityId?: string | null;
  detail: string;
  kind: AuditKind;
  /** Set by handlers so the completeness check can see the write. */
  request?: FastifyRequest;
}

export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.query(sql`
    insert into audit_events (
      actor_user_id, actor_role, action, target_type, target_id, entity_id, detail, kind
    ) values (
      ${input.actor.userId}, ${input.actor.role}, ${input.action}, ${input.targetType},
      ${input.targetId ?? null}, ${input.entityId ?? null}, ${input.detail.slice(0, 4000)},
      ${input.kind}
    )
  `);
  if (input.request) input.request.auditWrites += 1;
}

/**
 * Routes that change state but are not business actions, with the reason each
 * is here. The list is short on purpose: every entry is a hole in FR-070, and
 * the ledger-replay path was deliberately *not* added to it — a POST returning
 * 200 with nothing recorded is usually a missing audit call, not an exemption.
 */
const AUDIT_EXEMPT = new Set([
  // Authentication has its own events, written by the auth routes themselves.
  'POST /auth/login',
  'POST /auth/logout',
  // A browser-generated report about the browser, not an action by a principal.
  'POST /api/security/csp-report',
  // Touches `last_seen_at` and nothing else — the same write every authenticated
  // request already performs implicitly. Auditing it would add one row per
  // active user every quarter-hour and record no decision anyone made.
  'POST /api/session/extend',
  // A UI language preference. Not a control, and auditing it would add noise to
  // a trail whose value depends on being readable.
  'PATCH /api/me/locale',
]);

/**
 * Development and test fail loudly; production logs at error level so the SIEM
 * alerts on it (ZT-008) without turning a missing audit line into an outage for
 * a user whose write already committed.
 */
export function registerAuditCompletenessCheck(app: FastifyInstance, strict: boolean): void {
  app.decorateRequest('auditWrites', 0);

  app.addHook('onSend', async (request, reply, payload) => {
    const method = request.method;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return payload;
    if (reply.statusCode >= 400) return payload;
    const key = `${method} ${request.routeOptions.url ?? request.url}`;
    if (AUDIT_EXEMPT.has(key)) return payload;
    if (request.auditWrites > 0) return payload;

    const message = `state-changing request ${key} completed without an audit event (FR-070)`;
    // ZT-008 alert 1. Counted before the throw, so the metric records the fact
    // in development too rather than only in the environment that tolerates it.
    auditFailures({ route: key });
    if (strict) throw new Error(message);
    request.log.error({ event: 'audit.missing', route: key }, message);
    return payload;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AuditQuery {
  kind?: string | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

/**
 * FR-071. Scoping is applied in the WHERE clause, not by filtering rows after
 * the fact — a role that may only see its own events never has the others in
 * memory. `viewAll` is decided by the caller from the capability matrix.
 *
 * Residency is applied here too, and was missing. `viewAll` means every actor's
 * events, not every *region's*: an administrator could read the detail of an
 * event about an entity the consolidation report correctly refuses to show, and
 * those details carry entity codes, line names and amounts. It is the same
 * failure the comment on `visibleEntityIds` records — residency applied in one
 * read path and forgotten in another — in the one place where "forgotten" is
 * hardest to notice, because an audit list looks complete whatever it omits.
 */
export async function readAudit(
  db: Db,
  principal: Principal,
  viewAll: boolean,
  scope: ServedScope,
  query: AuditQuery,
): Promise<unknown[]> {
  const conditions: SqlFragment[] = [sql`true`];

  if (!viewAll) {
    conditions.push(sql`ae.actor_user_id = ${principal.userId}`);
  }

  // Read as: there is no *existing* entity for this event that lies outside the
  // served set. That phrasing covers all four cases in one clause, and the last
  // one is why it is phrased this way rather than as an `exists`:
  //
  //   no entity        a governance, backup or version event — always visible
  //   entity served    visible
  //   entity elsewhere hidden
  //   entity deleted   visible, because `audit_events.entity_id` deliberately
  //                    has no foreign key so the trail outlives the row. An
  //                    `exists` test would hide the `entity.delete` event
  //                    itself, and an audit trail that cannot show a deletion
  //                    is not one.
  conditions.push(sql`
    not exists (
      select 1 from entities e
      where e.id = ae.entity_id
        and not (${servedEntityClause(scope)})
    )
  `);
  if (query.kind) {
    conditions.push(sql`ae.kind = ${query.kind}`);
  }
  if (query.q) {
    // FR-072 full-text search, bound as a parameter. `plainto_tsquery` also
    // means the user's text is never interpreted as query syntax.
    conditions.push(sql`
      to_tsvector('simple', ae.action || ' ' || ae.target_type || ' ' || ae.detail)
        @@ plainto_tsquery('simple', ${query.q})
    `);
  }

  // Ordering is fixed, not caller-supplied; the allow-list call documents the
  // rule and fails loudly if that ever changes (SEC-020).
  const orderBy = identifier('ae.seq desc', ['ae.seq desc']);

  return db.query(sql`
    select
      ae.id, ae.occurred_at, ae.action, ae.target_type, ae.target_id,
      ae.entity_id, ae.detail, ae.kind, ae.actor_role,
      coalesce(u.display_name, 'Removed user') as actor_name
    from audit_events ae
    join users u on u.id = ae.actor_user_id
    where ${join(conditions, ' and ')}
    order by ${orderBy}
    limit ${query.limit} offset ${query.offset}
  `);
}

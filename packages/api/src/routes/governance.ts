/**
 * Data governance and data-subject rights (SPEC §9, PRIV-002, PRIV-003,
 * CMP-103).
 *
 * Data-subject actions are first-class endpoints rather than scripts, because a
 * script leaves no audit trail and cannot be tested. Everything here is a
 * privileged capability and everything writes a `governance` event.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requires } from '../http/guard.ts';
import { badRequest, conflict, notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { privilegeChanges } from '../observability/metrics.ts';

export async function registerGovernanceRoutes(
  app: FastifyInstance,
  db: Db,
  _config: AppConfig,
): Promise<void> {
  // -------------------------------------------------------------------------
  // Governance (SPEC §9, PRIV-002, PRIV-003)
  // -------------------------------------------------------------------------

  app.get('/api/governance/classifications', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select field_key as "fieldKey", data_class as "dataClass", updated_at as "updatedAt"
      from data_classifications order by field_key
    `),
  );

  app.put('/api/governance/classifications', { config: requires('governance.edit') }, async (request) => {
    const body = parse(schemas.classificationSchema, request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        insert into data_classifications (field_key, data_class, updated_by, updated_at)
        values (${body.fieldKey}, ${body.dataClass}, ${principal.userId}, now())
        on conflict (field_key)
        do update set data_class = excluded.data_class, updated_by = excluded.updated_by,
                      updated_at = now()
      `);
      // ZT-008 alert 3: someone changing who can see what.
      privilegeChanges({ action: 'governance.classification' });
      await writeAudit(tx, {
        actor: principal,
        action: 'governance.classification',
        targetType: 'data_classification',
        targetId: null,
        detail: `${body.fieldKey} classified as ${body.dataClass}`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  app.get('/api/governance/retention', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select dataset, months, updated_at as "updatedAt" from retention_policies order by dataset
    `),
  );

  app.put('/api/governance/retention', { config: requires('governance.edit') }, async (request) => {
    const body = parse(schemas.retentionSchema, request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        insert into retention_policies (dataset, months, updated_by, updated_at)
        values (${body.dataset}, ${body.months}, ${principal.userId}, now())
        on conflict (dataset)
        do update set months = excluded.months, updated_by = excluded.updated_by, updated_at = now()
      `);
      // ZT-008 alert 3: someone changing who can see what.
      privilegeChanges({ action: 'governance.retention' });
      await writeAudit(tx, {
        actor: principal,
        action: 'governance.retention',
        targetType: 'retention_policy',
        targetId: null,
        detail: `${body.dataset} retention set to ${body.months} months`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  /**
   * PRIV-003 / CMP-133 — data subject access. Exports everything held about one
   * person. Deliberately narrow: it returns their own records, not the budget
   * figures they happened to touch, which are commercial data belonging to the
   * group rather than personal data belonging to them.
   */
  app.get('/api/governance/subject/:userId/export', { config: requires('governance.edit') }, async (request) => {
    const { userId } = parse(z.object({ userId: schemas.uuid }), request.params);
    const principal = principalOf(request);

    const subject = await db.one(sql`
      select id, email, display_name as "displayName", role, is_active as "isActive",
             created_at as "createdAt", last_seen_at as "lastSeenAt",
             pseudonymised_at as "pseudonymisedAt"
      from users where id = ${userId}
    `);
    if (!subject) throw notFound('user does not exist');

    const comments = await db.query(sql`
      select body, created_at as "createdAt" from line_comments where author_id = ${userId}
    `);
    const auditEntries = await db.query(sql`
      select occurred_at as "occurredAt", action, target_type as "targetType", detail
      from audit_events where actor_user_id = ${userId} order by seq
    `);

    await writeAudit(db, {
      actor: principal,
      action: 'governance.subject.export',
      targetType: 'user',
      targetId: userId,
      detail: 'Exported personal data for a data subject request',
      kind: 'governance',
      request,
    });

    return { subject, comments, auditEntries };
  });

  /**
   * PRIV-003 / CMP-133 — erasure. The actor is pseudonymised and the audit
   * chain is left intact: the events still exist, still hash-link, and still
   * prove who approved what, but they no longer identify a person. Deleting the
   * audit rows instead would break both the chain and the statutory record.
   */
  app.post('/api/governance/subject/:userId/pseudonymise', { config: requires('governance.edit') }, async (request) => {
    const { userId } = parse(z.object({ userId: schemas.uuid }), request.params);
    const principal = principalOf(request);
    if (userId === principal.userId) {
      throw badRequest('an actor cannot pseudonymise their own account while signed in');
    }

    await db.transaction(async (tx) => {
      const updated = await tx.one<{ id: string }>(sql`
        update users set
          email = 'erased+' || id::text || '@invalid.example',
          display_name = 'Erased user',
          entra_oid = null,
          is_active = false,
          pseudonymised_at = now()
        where id = ${userId} and pseudonymised_at is null
        returning id
      `);
      if (!updated) throw conflict('user is already pseudonymised or does not exist');

      // Free text authored by the subject is deleted; the audit events that
      // record the act of commenting survive.
      await tx.query(sql`delete from line_comments where author_id = ${userId}`);
      await tx.query(sql`update sessions set revoked_at = now() where user_id = ${userId}`);

      // ZT-008 alert 3: someone changing who can see what.
      privilegeChanges({ action: 'governance.subject.pseudonymise' });
      await writeAudit(tx, {
        actor: principal,
        action: 'governance.subject.pseudonymise',
        targetType: 'user',
        targetId: userId,
        detail: 'Pseudonymised a departed user; audit chain retained',
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  /** PRIV-001 — the retention job, exposed so it can be triggered and tested. */
  app.post('/api/governance/retention/run', { config: requires('governance.edit') }, async (request) => {
    const principal = principalOf(request);

    const result = await db.transaction(async (tx) => {
      const freeText = await tx.query(sql`
        delete from line_comments
        where created_at < now() - make_interval(months =>
          (select months from retention_policies where dataset = 'free_text'))
        returning id
      `);
      const inactive = await tx.query(sql`
        update users set is_active = false
        where is_active
          and last_seen_at is not null
          and last_seen_at < now() - make_interval(months =>
            (select months from retention_policies where dataset = 'inactive_users'))
        returning id
      `);

      await writeAudit(tx, {
        actor: principal,
        action: 'governance.retention.run',
        targetType: 'retention_policy',
        targetId: null,
        detail: `Retention run: ${freeText.length} comments purged, ${inactive.length} users deactivated`,
        kind: 'governance',
        request,
      });

      return { commentsPurged: freeText.length, usersDeactivated: inactive.length };
    });

    return result;
  });

  /** CMP-103 — chain verification, surfaced so monitoring can alert on it. */
  app.get('/api/governance/audit-integrity', { config: requires('audit.viewAll') }, async () => {
    const row = await db.one<{ first_bad_seq: string | null }>(sql`
      select audit_verify_chain()::text as first_bad_seq
    `);
    return {
      intact: row?.first_bad_seq === null,
      firstBadSeq: row?.first_bad_seq ?? null,
    };
  });
}

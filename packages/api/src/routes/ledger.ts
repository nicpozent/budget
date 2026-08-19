/**
 * Ledger ingestion (FR-040).
 *
 * Actuals arrive as a batch. Three properties make a nightly feed safe:
 *
 *   idempotent  — `external_ref` is the feed's identifier for the extract.
 *                 Replaying a batch returns the first result and writes nothing.
 *   atomic      — the whole batch applies or none of it does, so a partial
 *                 network failure cannot leave half a month posted.
 *   accountable — rows that cannot be matched are stored as rejects, not
 *                 dropped. "The ledger sent 40 rows we could not match" is a
 *                 finding someone has to act on, not a log line nobody reads.
 *
 * Once a period is ledger-owned, hand editing is refused (see the actuals
 * handler in routes/lines.ts). That is the seam FR-040 describes: the cutover
 * is a feed, not a migration.
 *
 * Note on authentication: this is admin-only and deliberately *not* a step-up
 * capability, because a scheduled job cannot satisfy an interactive
 * re-authentication. See the comment in shared/authz.ts. When a service
 * principal exists it should hold `ledger.ingest` and nothing else.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Money, schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requires } from '../http/guard.ts';
import { badRequest } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { servedEntityClause } from '../services/residency.ts';

interface Reject {
  rowIndex: number;
  lineRef: string;
  period: number | null;
  reason: string;
}

export async function registerLedgerRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  app.post('/api/ledger/actuals', { config: requires('ledger.ingest') }, async (request, reply) => {
    const body = parse(schemas.ledgerBatchSchema, request.body);
    const principal = principalOf(request);

    if (body.fiscalYear !== config.FISCAL_YEAR) {
      throw badRequest(`this deployment serves FY${config.FISCAL_YEAR}`);
    }

    // Idempotency first, outside the transaction: a replay is the common case
    // for a retrying scheduler and should not take write locks.
    const seen = await db.one<{
      id: string;
      row_count: number;
      accepted_count: number;
      rejected_count: number;
      status: string;
    }>(sql`
      select id, row_count, accepted_count, rejected_count, status
      from ledger_batches where external_ref = ${body.externalRef}
    `);
    if (seen) {
      // The replay is recorded even though it changed nothing. A scheduler stuck
      // re-posting the same batch is a real operational signal, and it is the
      // only trace that would show it; the audit-completeness hook would refuse
      // a successful POST with no event anyway, and exempting routes is how that
      // guarantee rots.
      await db.transaction(async (tx) => {
        await writeAudit(tx, {
          actor: principal,
          action: 'ledger.replay',
          targetType: 'ledger_batch',
          targetId: seen.id,
          detail: `Ledger batch ${body.externalRef} re-submitted; already applied, ignored`,
          kind: 'change',
          request,
        });
      });

      return reply.status(200).send({
        batchId: seen.id,
        replayed: true,
        received: seen.row_count,
        accepted: seen.accepted_count,
        rejected: seen.rejected_count,
        status: seen.status,
      });
    }

    // Duplicate (lineRef, period) inside one batch is a feed defect: two
    // postings for the same cell with no defined precedence. Reject both rather
    // than letting insertion order pick a winner.
    const occurrences = new Map<string, number[]>();
    for (const [index, row] of body.rows.entries()) {
      const key = `${row.lineRef}\u0000${row.period}`;
      occurrences.set(key, [...(occurrences.get(key) ?? []), index]);
    }

    const result = await db.transaction(async (tx) => {
      // Resolve the feed's line references to our lines, honouring residency:
      // a line outside this deployment's region is not addressable here.
      const refs = [...new Set(body.rows.map((r) => r.lineRef))];
      const lines = await tx.query<{ id: string; ledger_ref: string; entity_id: string }>(sql`
        select li.id, li.ledger_ref, li.entity_id
        from line_items li
        join entities e on e.id = li.entity_id
        where li.ledger_ref = any(${refs}::text[])
          and li.deleted_at is null
          and ${servedEntityClause(config.served)}
      `);
      const byRef = new Map(lines.map((l) => [l.ledger_ref, l]));

      const batch = await tx.one<{ id: string }>(sql`
        insert into ledger_batches
          (external_ref, fiscal_year, source_system, received_by,
           row_count, accepted_count, rejected_count, status)
        values (${body.externalRef}, ${body.fiscalYear}, ${body.sourceSystem},
                ${principal.userId}, ${body.rows.length}, 0, ${body.rows.length}, 'rejected')
        returning id
      `);

      const rejects: Reject[] = [];
      const entityIds = new Set<string>();
      let accepted = 0;

      for (const [index, row] of body.rows.entries()) {
        const duplicated = (occurrences.get(`${row.lineRef}\u0000${row.period}`) ?? []).length > 1;
        if (duplicated) {
          rejects.push({
            rowIndex: index,
            lineRef: row.lineRef,
            period: row.period,
            reason: 'duplicate line and period within the batch',
          });
          continue;
        }

        const line = byRef.get(row.lineRef);
        if (!line) {
          rejects.push({
            rowIndex: index,
            lineRef: row.lineRef,
            period: row.period,
            reason: 'no active line with that ledger reference in this region',
          });
          continue;
        }

        // Money parses the string, so a value the database would silently
        // coerce is rejected here with the row that carried it.
        try {
          Money.parse(row.amount);
        } catch {
          rejects.push({
            rowIndex: index,
            lineRef: row.lineRef,
            period: row.period,
            reason: 'amount is not a valid decimal',
          });
          continue;
        }

        await tx.query(sql`
          insert into actuals
            (line_id, fiscal_year, period, amount, recorded_by, source,
             ledger_batch_id, ledger_ref)
          values (${line.id}, ${body.fiscalYear}, ${row.period}, ${row.amount},
                  ${principal.userId}, 'ledger', ${batch!.id}, ${row.postingRef ?? null})
          on conflict (line_id, fiscal_year, period)
          do update set amount = excluded.amount, recorded_by = excluded.recorded_by,
                        recorded_at = now(), source = 'ledger',
                        ledger_batch_id = excluded.ledger_batch_id,
                        ledger_ref = excluded.ledger_ref
        `);
        entityIds.add(line.entity_id);
        accepted += 1;
      }

      for (const reject of rejects) {
        await tx.query(sql`
          insert into ledger_batch_rejects (batch_id, row_index, line_ref, period, reason)
          values (${batch!.id}, ${reject.rowIndex}, ${reject.lineRef}, ${reject.period},
                  ${reject.reason})
        `);
      }

      const status =
        accepted === 0 ? 'rejected' : rejects.length === 0 ? 'accepted' : 'partial';

      await tx.query(sql`
        update ledger_batches
        set accepted_count = ${accepted}, rejected_count = ${rejects.length}, status = ${status}
        where id = ${batch!.id}
      `);

      // ZT-008 wants volume in the audit record. The counts are the alertable
      // signal: a batch that suddenly rewrites every period is what an alert on
      // this event should catch.
      await writeAudit(tx, {
        actor: principal,
        action: 'ledger.ingest',
        targetType: 'ledger_batch',
        targetId: batch!.id,
        detail:
          `Ledger batch ${body.externalRef} from ${body.sourceSystem}: ` +
          `${accepted} accepted, ${rejects.length} rejected, ` +
          `${entityIds.size} entities affected`,
        kind: 'change',
        request,
      });

      return { batchId: batch!.id, accepted, rejected: rejects.length, status, rejects };
    });

    return reply.status(201).send({
      batchId: result.batchId,
      replayed: false,
      received: body.rows.length,
      accepted: result.accepted,
      rejected: result.rejected,
      status: result.status,
      // Returned inline so a scheduler can log the reason without a second
      // call. Bounded by the batch size cap in the schema.
      rejects: result.rejects,
    });
  });

  app.get('/api/ledger/batches', { config: requires('ledger.ingest') }, async () =>
    db.query(sql`
      select b.id, b.external_ref as "externalRef", b.source_system as "sourceSystem",
             b.fiscal_year as "fiscalYear", b.received_at as "receivedAt",
             b.row_count as "rowCount", b.accepted_count as "acceptedCount",
             b.rejected_count as "rejectedCount", b.status,
             coalesce(u.display_name, 'Removed user') as "receivedBy"
      from ledger_batches b
      left join users u on u.id = b.received_by
      order by b.received_at desc limit 100
    `),
  );

  app.get('/api/ledger/batches/:batchId/rejects', { config: requires('ledger.ingest') }, async (request) => {
    const { batchId } = parse(z.object({ batchId: schemas.uuid }), request.params);
    return db.query(sql`
      select row_index as "rowIndex", line_ref as "lineRef", period, reason
      from ledger_batch_rejects where batch_id = ${batchId} order by row_index
    `);
  });

  /**
   * Which periods the ledger owns. The grid uses this to render a cell as
   * read-only rather than letting an owner discover it by being refused.
   */
  app.get('/api/ledger/coverage', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select period, count(*)::int as lines, max(recorded_at) as "lastPostedAt"
      from actuals
      where fiscal_year = ${config.FISCAL_YEAR} and source = 'ledger'
      group by period order by period
    `),
  );
}

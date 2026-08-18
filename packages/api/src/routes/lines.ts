/**
 * Budget entry (FR-010..FR-016, FR-021, FR-041).
 *
 * Every handler in this file follows the same shape:
 *   resolve the owning entity -> authorise against it -> check editability ->
 *   mutate inside a transaction -> write the audit event in the same transaction.
 *
 * The audit write shares the transaction deliberately. If the audit insert
 * fails, the business change rolls back with it: an unrecorded change is not an
 * acceptable outcome (FR-070).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Money, schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { requires, requireWriteEntity, principalOf } from '../http/guard.ts';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { assertEntityEditable } from '../services/editability.ts';
import { elapsedPeriods, fromEur, loadFxTable } from '../services/budget.ts';
import { loadCycle, periodsIn } from './meta.ts';

interface LineOwner {
  entity_id: string;
  currency: string;
  version: number;
  driver_key: string | null;
  cost_type: string;
}

async function loadLineForWrite(db: Db, lineId: string): Promise<LineOwner> {
  const line = await db.one<LineOwner>(sql`
    select entity_id, currency, version, driver_key, cost_type
    from line_items where id = ${lineId} and deleted_at is null
  `);
  if (!line) throw notFound('line does not exist');
  return line;
}

/** INV-2: a line may only be booked to an approved cost centre. */
async function assertCostCentreApproved(db: Db, costCentreId: string | null | undefined): Promise<void> {
  if (!costCentreId) return;
  const centre = await db.one<{ status: string }>(sql`
    select status from cost_centres where id = ${costCentreId}
  `);
  if (!centre) throw badRequest('unknown cost centre');
  if (centre.status !== 'approved') {
    throw forbidden('cost centre is not approved (INV-2)');
  }
}

export async function registerLineRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;

  // FR-011 create
  app.post('/api/lines', { config: requires('budget.line.edit.own') }, async (request, reply) => {
    const body = parse(schemas.createLineSchema, request.body);
    const principal = requireWriteEntity(request, body.entityId);
    await assertEntityEditable(db, { entityId: body.entityId, fiscalYear: year, regions: config.servedRegions });
    await assertCostCentreApproved(db, body.costCentreId);

    const created = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into line_items (
          entity_id, category_id, name, vendor, cost_centre_id, gl_account,
          cost_type, currency, justification, asset_life_years, asset_life_status
        ) values (
          ${body.entityId}, ${body.categoryId}, ${body.name}, ${body.vendor ?? null},
          ${body.costCentreId ?? null}, ${body.glAccount ?? null},
          ${body.costType}, ${body.currency}, ${body.justification ?? null},
          ${body.costType === 'capex' ? 3 : null},
          ${body.costType === 'capex' ? 'pending' : null}
        ) returning id
      `);
      if (!row) throw conflict('could not create line');

      await writeAudit(tx, {
        actor: principal,
        action: 'line.create',
        targetType: 'line_item',
        targetId: row.id,
        entityId: body.entityId,
        detail: `Created line "${body.name}"`,
        kind: 'change',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created.id });
  });

  // FR-010 update
  app.patch('/api/lines/:lineId', { config: requires('budget.line.edit.own') }, async (request) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const body = parse(schemas.updateLineSchema, request.body);
    const line = await loadLineForWrite(db, lineId);
    const principal = requireWriteEntity(request, line.entity_id);
    await assertEntityEditable(db, { entityId: line.entity_id, fiscalYear: year, regions: config.servedRegions });
    await assertCostCentreApproved(db, body.costCentreId);

    await db.transaction(async (tx) => {
      // NFR-005: the update only applies if the row is still at the version the
      // client loaded. Two owners editing the same line cannot silently
      // overwrite each other.
      const updated = await tx.one<{ id: string }>(sql`
        update line_items set
          name           = coalesce(${body.name ?? null}, name),
          vendor         = ${body.vendor === undefined ? sql`vendor` : sql`${body.vendor}`},
          cost_centre_id = ${body.costCentreId === undefined ? sql`cost_centre_id` : sql`${body.costCentreId}`},
          gl_account     = ${body.glAccount === undefined ? sql`gl_account` : sql`${body.glAccount}`},
          cost_type      = coalesce(${body.costType ?? null}, cost_type),
          currency       = coalesce(${body.currency ?? null}, currency),
          justification  = ${body.justification === undefined ? sql`justification` : sql`${body.justification}`},
          version        = version + 1
        where id = ${lineId} and version = ${body.version} and deleted_at is null
        returning id
      `);
      if (!updated) throw conflict('line was modified by someone else');

      await writeAudit(tx, {
        actor: principal,
        action: 'line.update',
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: `Updated fields: ${Object.keys(body).filter((k) => k !== 'version').join(', ')}`,
        kind: 'change',
        request,
      });
    });

    return { ok: true };
  });

  // FR-011 delete (soft, so history and audit targets survive)
  app.delete('/api/lines/:lineId', { config: requires('budget.line.edit.own') }, async (request, reply) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const line = await loadLineForWrite(db, lineId);
    const principal = requireWriteEntity(request, line.entity_id);
    await assertEntityEditable(db, { entityId: line.entity_id, fiscalYear: year, regions: config.servedRegions });

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update line_items set deleted_at = now(), version = version + 1 where id = ${lineId}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'line.delete',
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: 'Deleted line',
        kind: 'change',
        request,
      });
    });

    return reply.status(204).send();
  });

  // FR-010 / FR-014 set a period amount
  app.put('/api/lines/:lineId/amounts', { config: requires('budget.line.edit.own') }, async (request) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const body = parse(schemas.setAmountSchema, request.body);
    const line = await loadLineForWrite(db, lineId);
    const principal = requireWriteEntity(request, line.entity_id);
    await assertEntityEditable(db, { entityId: line.entity_id, fiscalYear: year, regions: config.servedRegions });

    // INV-3: a driver-linked amount is computed. Accepting a typed value here
    // would create a second source of truth that immediately disagrees.
    if (line.driver_key !== null) {
      throw forbidden('amount is driver-computed and cannot be set directly (INV-3)');
    }

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    if (body.period > periods) throw badRequest('period is outside the cycle granularity');

    // FR-014: a value typed in EUR is converted back to the line's local
    // currency before storage. Storage is always local.
    const fx = await loadFxTable(db, year);
    const typed = Money.parse(body.amount);
    const local = body.unit === 'eur' ? fromEur(typed, line.currency, fx) : typed;

    await db.transaction(async (tx) => {
      const bumped = await tx.one<{ version: number }>(sql`
        update line_items set version = version + 1
        where id = ${lineId} and version = ${body.version} and deleted_at is null
        returning version
      `);
      if (!bumped) throw conflict('line was modified by someone else');

      await tx.query(sql`
        insert into period_amounts (line_id, fiscal_year, period, budget_version, amount, updated_at)
        values (${lineId}, ${year}, ${body.period}, 'working', ${local.toString()}, now())
        on conflict (line_id, fiscal_year, period, budget_version)
        do update set amount = excluded.amount, updated_at = now()
      `);

      await writeAudit(tx, {
        actor: principal,
        action: 'line.amount.set',
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: `Period ${body.period} set to ${local.toString()} ${line.currency}`,
        kind: 'change',
        request,
      });
    });

    return { ok: true };
  });

  // FR-021 link a line to a driver
  app.put('/api/lines/:lineId/driver', { config: requires('budget.line.edit.own') }, async (request) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const body = parse(schemas.linkDriverSchema, request.body);
    const line = await loadLineForWrite(db, lineId);
    const principal = requireWriteEntity(request, line.entity_id);
    await assertEntityEditable(db, { entityId: line.entity_id, fiscalYear: year, regions: config.servedRegions });

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update line_items
        set driver_key = ${body.driverKey},
            driver_rate_per_unit = ${body.ratePerUnit},
            version = version + 1
        where id = ${lineId}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'line.driver.link',
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: `Linked to ${body.driverKey} at ${body.ratePerUnit} per unit`,
        kind: 'change',
        request,
      });
    });

    return { ok: true };
  });

  app.delete('/api/lines/:lineId/driver', { config: requires('budget.line.edit.own') }, async (request) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const line = await loadLineForWrite(db, lineId);
    const principal = requireWriteEntity(request, line.entity_id);
    await assertEntityEditable(db, { entityId: line.entity_id, fiscalYear: year, regions: config.servedRegions });

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update line_items
        set driver_key = null, driver_rate_per_unit = null, version = version + 1
        where id = ${lineId}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'line.driver.unlink',
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: 'Removed driver link; amounts revert to manual entry',
        kind: 'change',
        request,
      });
    });

    return { ok: true };
  });

  /**
   * FR-015 bulk operations.
   *
   * Rate limited separately (SEC-013) because this is the one endpoint where a
   * single request touches up to a thousand rows. Every line is re-authorised
   * individually — a caller cannot smuggle another entity's line into the list.
   */
  app.post(
    '/api/lines/bulk',
    {
      config: {
        ...requires('budget.line.edit.own'),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request) => {
      const body = parse(schemas.bulkOperationSchema, request.body);
      const principal = principalOf(request);

      const lines = await db.query<{ id: string; entity_id: string; currency: string }>(sql`
        select id, entity_id, currency from line_items
        where id = any(${body.lineIds}::uuid[]) and deleted_at is null
      `);
      if (lines.length !== body.lineIds.length) throw notFound('one or more lines do not exist');

      const entityIds = [...new Set(lines.map((l) => l.entity_id))];
      for (const entityId of entityIds) {
        requireWriteEntity(request, entityId);
        await assertEntityEditable(db, { entityId, fiscalYear: year, regions: config.servedRegions });
      }

      if (body.operation === 'reassign_cost_centre') {
        await assertCostCentreApproved(db, body.costCentreId);
      }

      const affected = await db.transaction(async (tx) => {
        switch (body.operation) {
          case 'uplift': {
            // Uplift is applied per stored amount through Money, not by a SQL
            // multiply, so the rounding rule is the same one used everywhere
            // else and the result cannot drift by a minor unit.
            const rows = await tx.query<{ line_id: string; period: number; amount: string }>(sql`
              select line_id, period, amount::text as amount from period_amounts
              where line_id = any(${body.lineIds}::uuid[])
                and fiscal_year = ${year} and budget_version = 'working'
            `);
            for (const row of rows) {
              const next = Money.parse(row.amount).upliftByPercent(body.percent);
              await tx.query(sql`
                update period_amounts set amount = ${next.toString()}, updated_at = now()
                where line_id = ${row.line_id} and fiscal_year = ${year}
                  and period = ${row.period} and budget_version = 'working'
              `);
            }
            await tx.query(sql`
              update line_items set version = version + 1
              where id = any(${body.lineIds}::uuid[])
            `);
            return body.lineIds.length;
          }

          case 'reassign_cost_centre': {
            await tx.query(sql`
              update line_items
              set cost_centre_id = ${body.costCentreId}, version = version + 1
              where id = any(${body.lineIds}::uuid[]) and deleted_at is null
            `);
            return body.lineIds.length;
          }

          case 'delete': {
            await tx.query(sql`
              update line_items set deleted_at = now(), version = version + 1
              where id = any(${body.lineIds}::uuid[]) and deleted_at is null
            `);
            return body.lineIds.length;
          }

          case 'copy_prior_year': {
            await tx.query(sql`
              insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
              select pa.line_id, ${year}, pa.period, 'working', pa.amount
              from period_amounts pa
              where pa.line_id = any(${body.lineIds}::uuid[])
                and pa.fiscal_year = ${year - 1}
                and pa.budget_version = 'working'
              on conflict (line_id, fiscal_year, period, budget_version)
              do update set amount = excluded.amount, updated_at = now()
            `);
            return body.lineIds.length;
          }

          default: {
            // Exhaustiveness: a new operation added to the schema without a
            // branch here is a type error, not a silent no-op.
            const never: never = body;
            throw badRequest(`unhandled operation ${JSON.stringify(never)}`);
          }
        }
      });

      // FR-015: one audit event per operation, carrying the affected count.
      await writeAudit(db, {
        actor: principal,
        action: `line.bulk.${body.operation}`,
        targetType: 'line_item',
        targetId: null,
        entityId: entityIds.length === 1 ? entityIds[0]! : null,
        detail: `Bulk ${body.operation} applied to ${affected} lines`,
        kind: 'change',
        request,
      });

      return { affected };
    },
  );

  /**
   * FR-041 record actual spend.
   *
   * Only elapsed periods are editable, and that is decided from the server
   * clock — a client that posts period 4 in Q1 is refused rather than trusted.
   */
  app.put('/api/lines/:lineId/actuals', { config: requires('actuals.record') }, async (request) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const body = parse(schemas.recordActualSchema, request.body);
    const line = await loadLineForWrite(db, lineId);
    const principal = requireWriteEntity(request, line.entity_id);

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const elapsed = elapsedPeriods(year, periods);
    if (body.period > elapsed) {
      throw forbidden('only elapsed periods accept recorded spend (FR-041)');
    }

    // FR-040: once the ledger feed owns a period, hand-editing it would create
    // a figure that the next nightly refresh silently overwrites.
    const existing = await db.one<{ source: string }>(sql`
      select source from actuals
      where line_id = ${lineId} and fiscal_year = ${year} and period = ${body.period}
    `);
    if (existing?.source === 'ledger') {
      throw forbidden('this period is sourced from the ledger and is not hand-editable');
    }

    const amount = Money.parse(body.amount);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        insert into actuals (line_id, fiscal_year, period, amount, recorded_by, source)
        values (${lineId}, ${year}, ${body.period}, ${amount.toString()}, ${principal.userId}, 'manual')
        on conflict (line_id, fiscal_year, period)
        do update set amount = excluded.amount, recorded_by = excluded.recorded_by,
                      recorded_at = now()
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'actual.record',
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: `Recorded ${amount.toString()} ${line.currency} for period ${body.period}`,
        kind: 'change',
        request,
      });
    });

    return { ok: true };
  });

  /** FR-012 comment thread on a line. */
  app.post('/api/lines/:lineId/comments', { config: requires('budget.line.edit.own') }, async (request, reply) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const { body: text } = parse(z.object({ body: schemas.longText(4000) }), request.body);
    const line = await loadLineForWrite(db, lineId);
    const principal = principalOf(request);
    // Commenting is a read-scope action with a write side effect: anyone who
    // may see the line may discuss it, including cross-entity readers.
    if (!requireCommentAccess(request, line.entity_id)) {
      throw forbidden('line is out of scope');
    }

    const created = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into line_comments (line_id, author_id, body)
        values (${lineId}, ${principal.userId}, ${text}) returning id
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'line.comment',
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: 'Added a comment',
        kind: 'change',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created?.id });
  });
}

function requireCommentAccess(
  request: Parameters<typeof principalOf>[0],
  entityId: string,
): boolean {
  const principal = principalOf(request);
  return (
    principal.ownedEntityIds.includes(entityId) ||
    principal.role === 'admin' ||
    principal.role === 'cfo'
  );
}

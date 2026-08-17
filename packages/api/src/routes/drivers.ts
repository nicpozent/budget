/**
 * Drivers, driver trees and allocation pools (FR-020..FR-023).
 *
 * One domain: the quantities a budget is computed *from*, rather than the
 * amounts it is made of. A driver is either typed in or derived from another —
 * see `services/drivers.ts` for why a derived figure is stored rather than
 * resolved at read time, and why acyclicity is checked there and not in a
 * constraint.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requires } from '../http/guard.ts';
import { forbidden } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { recomputeDriverTree } from '../services/drivers.ts';

export async function registerDriverRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;
  // -------------------------------------------------------------------------
  // Drivers and allocations (FR-020, FR-023)
  // -------------------------------------------------------------------------

  /**
   * FR-020/FR-021. A driver is either typed in or derived from another driver
   * for the same entity and year — see `services/drivers.ts` for why the
   * derived figure is stored rather than computed at read time.
   */
  app.put('/api/drivers', { config: requires('budget.line.edit.own') }, async (request) => {
    const body = parse(schemas.driverInputSchema, request.body);
    const principal = principalOf(request);
    if (!principal.ownedEntityIds.includes(body.entityId) && principal.role !== 'admin') {
      throw forbidden('entity out of write scope');
    }

    const derivedFrom = body.derivedFrom ?? null;
    const factor = body.factor ?? null;

    const changed = await db.transaction(async (tx) => {
      await tx.query(sql`
        insert into drivers (entity_id, driver_key, unit, value, fiscal_year, derived_from, factor)
        values (${body.entityId}, ${body.driverKey}, ${body.unit}, ${body.value ?? 0}, ${year},
                ${derivedFrom}, ${factor})
        on conflict (entity_id, driver_key, fiscal_year)
        do update set
          -- A derived driver's stored value is about to be recomputed, so
          -- keeping whatever was posted would only be a value that exists for
          -- one statement. A root driver takes the figure that was typed.
          value = case when ${derivedFrom}::text is null
                       then excluded.value else drivers.value end,
          unit = excluded.unit,
          derived_from = excluded.derived_from,
          factor = excluded.factor
      `);

      // Runs on every write, including a write that only changed a root value:
      // that is the point of a tree, and it is also what refuses a cycle before
      // it is committed rather than after.
      const moved = await recomputeDriverTree(tx, body.entityId, year);

      const definition = derivedFrom
        ? `${body.driverKey} defined as ${factor} × ${derivedFrom}`
        : `${body.driverKey} set to ${body.value ?? 0} ${body.unit}`;
      const downstream = moved.length > 0
        ? `; recomputed ${moved.map((m) => `${m.key} ${m.from}→${m.to}`).join(', ')}`
        : '';

      await writeAudit(tx, {
        actor: principal,
        action: 'driver.update',
        targetType: 'driver',
        targetId: null,
        entityId: body.entityId,
        // FR-021: every driver-linked line recalculates from this, so the
        // change is recorded with its blast radius stated rather than implied —
        // a tree makes the radius wider than the edit.
        detail: `${definition}${downstream}`,
        kind: 'change',
        request,
      });

      return moved;
    });

    return { ok: true, recomputed: changed };
  });

  app.post('/api/cycle/headcount-planning', { config: requires('cycle.rules') }, async (request) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update cycles set headcount_planning = ${enabled}, updated_at = now()
        where fiscal_year = ${year}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'cycle.headcount_planning',
        targetType: 'cycle',
        targetId: null,
        // FR-022: off makes headcount-linked lines dormant. Nothing is deleted,
        // which is why this is reversible and worth saying in the record.
        detail: `Headcount planning ${enabled ? 'enabled' : 'disabled'}; headcount-linked lines ${enabled ? 'recomputed' : 'dormant'}`,
        kind: 'workflow',
        request,
      });
    });

    return { ok: true };
  });

  app.get('/api/allocations', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select id, name, amount::text as amount, currency, driver_key as "driverKey"
      from allocation_pools where fiscal_year = ${year} order by name
    `),
  );

  app.put('/api/allocations', { config: requires('allocation.edit') }, async (request) => {
    const body = parse(
      z.object({
        name: schemas.shortText(120),
        amount: schemas.moneyString,
        currency: schemas.currency,
        driverKey: schemas.driverKey,
      }),
      request.body,
    );
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        insert into allocation_pools (name, amount, currency, driver_key, fiscal_year)
        values (${body.name}, ${body.amount}, ${body.currency}, ${body.driverKey}, ${year})
        on conflict (name, fiscal_year)
        do update set amount = excluded.amount, currency = excluded.currency,
                      driver_key = excluded.driver_key
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'allocation.update',
        targetType: 'allocation_pool',
        targetId: null,
        // INV-6: charges are read-only to the receiving entity, so only an
        // admin action can change what an entity is charged.
        detail: `Pool "${body.name}" set to ${body.amount} ${body.currency} on ${body.driverKey}`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });
}

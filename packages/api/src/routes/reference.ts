/**
 * Reference data an administrator maintains: cost centres, entities and FX
 * rates (FR-013, FR-014, SEC-012, SPEC §5).
 *
 * These three sit together because they are the same kind of thing — the fixed
 * points every budget line is written against — and because each is a
 * privileged write with a governance audit event behind it. Splitting further
 * would give three files of two endpoints whose only shared idea is already
 * stated here.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { principalOf, requires } from '../http/guard.ts';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { privilegeChanges } from '../observability/metrics.ts';

export async function registerReferenceRoutes(
  app: FastifyInstance,
  db: Db,
  _config: AppConfig,
): Promise<void> {
  // -------------------------------------------------------------------------
  // Cost centres (FR-013, SEC-012)
  // -------------------------------------------------------------------------

  app.post('/api/cost-centres', { config: requires('costCentre.create') }, async (request, reply) => {
    const body = parse(schemas.costCentreCreateSchema, request.body);
    const principal = principalOf(request);

    const created = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into cost_centres (code, description, created_by)
        values (${body.code}, ${body.description}, ${principal.userId})
        returning id
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'cost_centre.create',
        targetType: 'cost_centre',
        targetId: row?.id ?? null,
        detail: `Created cost centre ${body.code} (pending approval)`,
        kind: 'governance',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created?.id });
  });

  app.post('/api/cost-centres/:id/decision', { config: requires('costCentre.approve') }, async (request) => {
    const { id } = parse(z.object({ id: schemas.uuid }), request.params);
    const { decision } = parse(
      z.object({ decision: z.enum(['approved', 'rejected']) }),
      request.body,
    );
    const principal = principalOf(request);

    const centre = await db.one<{ created_by: string; code: string; status: string }>(sql`
      select created_by, code, status from cost_centres where id = ${id}
    `);
    if (!centre) throw notFound('cost centre does not exist');
    // SEC-012: the creator cannot approve their own cost centre. The schema
    // constraint would reject it too; this produces the better message.
    if (centre.created_by === principal.userId) {
      throw forbidden('the actor who creates a cost centre cannot approve it (SEC-012)');
    }

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update cost_centres
        set status = ${decision}, approved_by = ${principal.userId}, decided_at = now()
        where id = ${id}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: `cost_centre.${decision}`,
        targetType: 'cost_centre',
        targetId: id,
        detail: `Cost centre ${centre.code} ${decision}`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Entities and FX (FR-014, SPEC §5)
  // -------------------------------------------------------------------------

  app.post('/api/entities', { config: requires('entity.manage') }, async (request, reply) => {
    const body = parse(
      z.object({
        code: schemas.shortText(32),
        name: schemas.shortText(200),
        currency: schemas.currency,
        residency: z.enum(['eu', 'ch', 'apac', 'cn']),
        ownerEmail: z.string().email().max(320).optional(),
      }),
      request.body,
    );
    const principal = principalOf(request);

    const created = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into entities (code, name, currency, residency)
        values (${body.code}, ${body.name}, ${body.currency}, ${body.residency})
        returning id
      `);
      if (!row) throw conflict('entity code already exists');

      if (body.ownerEmail) {
        const owner = await tx.one<{ id: string }>(sql`
          select id from users where email = ${body.ownerEmail.toLowerCase()}
        `);
        if (!owner) throw badRequest('owner is not a known user');
        await tx.query(sql`
          insert into entity_owners (entity_id, user_id) values (${row.id}, ${owner.id})
          on conflict do nothing
        `);
      }

      // ZT-008 alert 3: someone changing who can see what.
      privilegeChanges({ action: 'entity.create' });
      await writeAudit(tx, {
        actor: principal,
        action: 'entity.create',
        targetType: 'entity',
        targetId: row.id,
        entityId: row.id,
        detail: `Created entity ${body.code} in ${body.residency}`,
        kind: 'governance',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created.id });
  });

  app.delete('/api/entities/:entityId', { config: requires('entity.manage') }, async (request, reply) => {
    const { entityId } = parse(z.object({ entityId: schemas.uuid }), request.params);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      const removed = await tx.one<{ code: string }>(sql`
        delete from entities where id = ${entityId} returning code
      `);
      if (!removed) throw notFound('entity does not exist');
      await writeAudit(tx, {
        actor: principal,
        action: 'entity.delete',
        targetType: 'entity',
        targetId: entityId,
        detail: `Removed entity ${removed.code}`,
        kind: 'governance',
        request,
      });
    });

    return reply.status(204).send();
  });

  /**
   * FR-014 / NFR-003. Editing a rate does not rewrite any stored amount —
   * conversion happens at read time, so this single write restates every
   * derived figure consistently, and the history of the rate itself is kept.
   */
  app.put('/api/fx-rates', { config: requires('fx.edit') }, async (request) => {
    const body = parse(schemas.fxRateSchema, request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      const previous = await tx.one<{ rate: string }>(sql`
        select rate::text as rate from fx_rates
        where currency = ${body.currency} and fiscal_year = ${body.fiscalYear}
      `);
      await tx.query(sql`
        insert into fx_rates (currency, fiscal_year, rate, updated_by, updated_at)
        values (${body.currency}, ${body.fiscalYear}, ${body.rate}, ${principal.userId}, now())
        on conflict (currency, fiscal_year)
        do update set rate = excluded.rate, updated_by = excluded.updated_by, updated_at = now()
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'fx.update',
        targetType: 'fx_rate',
        targetId: null,
        detail: `${body.currency} FY${body.fiscalYear}: ${previous?.rate ?? 'unset'} -> ${body.rate}`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });
}

/**
 * Administration and governance (FR-013, FR-014, FR-020, FR-023, SPEC §9).
 *
 * Template definition lives in `routes/template.ts` and approval configuration
 * in `routes/approvals.ts` — see docs/adr/0006-route-modules.md.
 *
 * Everything here is a privileged capability, so every route carries a
 * step-up-eligible declaration and writes a `governance` or `change` audit
 * event. Data-subject actions (PRIV-003) are first-class endpoints rather than
 * scripts, because a script does not leave an audit trail and cannot be tested.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requires } from '../http/guard.ts';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { createBackup, listBackups, readBackup } from '../services/backup.ts';

export async function registerAdminRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;

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

  // -------------------------------------------------------------------------
  // Drivers and allocations (FR-020, FR-023)
  // -------------------------------------------------------------------------

  app.put('/api/drivers', { config: requires('budget.line.edit.own') }, async (request) => {
    const body = parse(
      z.object({
        entityId: schemas.uuid,
        driverKey: schemas.driverKey,
        unit: schemas.shortText(40),
        value: z.number().int().min(0).max(10_000_000),
      }),
      request.body,
    );
    const principal = principalOf(request);
    if (!principal.ownedEntityIds.includes(body.entityId) && principal.role !== 'admin') {
      throw forbidden('entity out of write scope');
    }

    await db.transaction(async (tx) => {
      await tx.query(sql`
        insert into drivers (entity_id, driver_key, unit, value, fiscal_year)
        values (${body.entityId}, ${body.driverKey}, ${body.unit}, ${body.value}, ${year})
        on conflict (entity_id, driver_key, fiscal_year)
        do update set value = excluded.value, unit = excluded.unit
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'driver.update',
        targetType: 'driver',
        targetId: null,
        entityId: body.entityId,
        // FR-021: every driver-linked line recalculates from this, so the
        // change is recorded with its blast radius implied.
        detail: `${body.driverKey} set to ${body.value} ${body.unit}`,
        kind: 'change',
        request,
      });
    });

    return { ok: true };
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

  // -------------------------------------------------------------------------
  // Operations: backup (backup.run / backup.download)
  // -------------------------------------------------------------------------

  /**
   * FR-107 (extension, ADR 0005). Admin-triggered backup.
   *
   * Rate limited hard: a backup is expensive and repeated backups are the shape
   * of a slow exfiltration. Step-up is applied by the guard because both
   * capabilities are in STEP_UP_CAPABILITIES.
   */
  app.post(
    '/api/admin/backups',
    {
      config: {
        ...requires('backup.run'),
        rateLimit: { max: 3, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const manifest = await createBackup(db, config, principal, request);
      return reply.status(201).send(manifest);
    },
  );

  app.get('/api/admin/backups', { config: requires('backup.run') }, async () => ({
    backups: await listBackups(db),
    // The client shows this rather than offering a button that cannot work.
    configured: Boolean(config.BACKUP_ENCRYPTION_KEY),
  }));

  /**
   * Download. Decrypted in-process for an authorised admin and streamed as an
   * attachment; the archive on disk stays encrypted. Integrity is verified
   * before a single byte is returned.
   */
  app.get(
    '/api/admin/backups/:backupId/download',
    {
      config: {
        ...requires('backup.download'),
        rateLimit: { max: 5, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      const { backupId } = parse(z.object({ backupId: schemas.uuid }), request.params);
      const principal = principalOf(request);

      const { manifest, contents } = await readBackup(db, config, backupId);

      await writeAudit(db, {
        actor: principal,
        action: 'backup.download',
        targetType: 'backup',
        targetId: backupId,
        detail: `Downloaded backup ${backupId} (${manifest.byteSize} bytes encrypted at rest)`,
        kind: 'governance',
        request,
      });

      return reply
        .header('Content-Type', 'application/x-ndjson')
        // SEC-033: fixed, non-reflected filename, served as an attachment.
        .header('Content-Disposition', `attachment; filename="spendifre-backup-${backupId}.jsonl"`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(contents);
    },
  );

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

/**
 * Template definition and versioning (FR-001..FR-005).
 *
 * A template version is a frozen field set. Editing fields is only possible
 * while a version is a draft; publishing freezes it and makes it the version
 * new budgets start on. An entity keeps the version it started on for the whole
 * cycle, which is the guarantee FR-005 asks for: republishing the template does
 * not move the goalposts under a budget already being filled in.
 *
 * The read endpoint therefore resolves fields *per entity*, not per year. That
 * is the part that makes versioning real rather than decorative — a grid always
 * renders the fields its own budget was started against.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requireReadEntity, requires } from '../http/guard.ts';
import { AppError, conflict, notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';

/**
 * The version whose fields apply to `entityId`, or the latest published version
 * when no entity is named. Returns null when nothing has been published yet,
 * which a caller must treat as "no template", not as an error.
 */
export async function resolveTemplateVersionId(
  db: Db,
  fiscalYear: number,
  entityId?: string,
): Promise<string | null> {
  if (entityId) {
    const pinned = await db.one<{ template_version_id: string | null }>(sql`
      select template_version_id from entities where id = ${entityId}
    `);
    if (pinned?.template_version_id) return pinned.template_version_id;
  }
  const latest = await db.one<{ id: string }>(sql`
    select id from template_versions
    where fiscal_year = ${fiscalYear} and state = 'published'
    order by version desc limit 1
  `);
  return latest?.id ?? null;
}

export async function registerTemplateRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;

  // -------------------------------------------------------------------------
  // Fields (FR-001)
  // -------------------------------------------------------------------------

  app.get('/api/template/fields', { config: authenticatedRoute }, async (request) => {
    const query = parse(
      z.object({ entityId: schemas.uuid.optional(), versionId: schemas.uuid.optional() }),
      request.query,
    );
    // Reading another entity's template tells you nothing about its figures,
    // but the scope check costs nothing and keeps every entity-addressed route
    // consistent (SEC-011).
    if (query.entityId) requireReadEntity(request, query.entityId);

    const versionId = query.versionId ?? (await resolveTemplateVersionId(db, year, query.entityId));
    if (!versionId) return [];

    return db.query(sql`
      select id, field_key as "fieldKey", label, field_type as "fieldType",
             required, visible, position
      from template_fields where template_version_id = ${versionId} order by position
    `);
  });

  /** Fields may only be edited while their version is a draft (FR-005). */
  app.patch('/api/template/fields/:fieldId', { config: requires('template.define') }, async (request) => {
    const { fieldId } = parse(z.object({ fieldId: schemas.uuid }), request.params);
    const body = parse(
      z.object({
        label: schemas.shortText(120).optional(),
        required: z.boolean().optional(),
        visible: z.boolean().optional(),
        position: z.number().int().min(0).max(500).optional(),
      }),
      request.body,
    );
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      const target = await tx.one<{ field_key: string; state: string }>(sql`
        select tf.field_key, tv.state
        from template_fields tf
        join template_versions tv on tv.id = tf.template_version_id
        where tf.id = ${fieldId} and tf.fiscal_year = ${year}
      `);
      if (!target) throw notFound('field does not exist');
      if (target.state === 'published') {
        // The version's state is already visible via GET /api/template/versions,
        // so naming it is not a disclosure — and "reload and try again" would be
        // wrong advice, since reloading will never make it editable.
        throw new AppError('conflict', 'template version is published', {
          version: 'this template version is published and immutable — open a new draft (FR-005)',
        });
      }

      await tx.query(sql`
        update template_fields set
          label    = coalesce(${body.label ?? null}, label),
          required = coalesce(${body.required ?? null}, required),
          visible  = coalesce(${body.visible ?? null}, visible),
          position = coalesce(${body.position ?? null}, position)
        where id = ${fieldId}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'template.field.update',
        targetType: 'template_field',
        targetId: fieldId,
        detail: `Updated field ${target.field_key}`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  /** Add a field to a draft version. */
  app.post('/api/template/versions/:versionId/fields', { config: requires('template.define') }, async (request, reply) => {
    const { versionId } = parse(z.object({ versionId: schemas.uuid }), request.params);
    const body = parse(schemas.templateFieldSchema, request.body);
    const principal = principalOf(request);

    const created = await db.transaction(async (tx) => {
      const version = await tx.one<{ state: string; version: number }>(sql`
        select state, version from template_versions
        where id = ${versionId} and fiscal_year = ${year}
      `);
      if (!version) throw notFound('template version does not exist');
      if (version.state === 'published') {
        throw conflict('this template version is published and immutable (FR-005)');
      }

      const row = await tx.one<{ id: string }>(sql`
        insert into template_fields
          (fiscal_year, template_version_id, field_key, label, field_type, required, visible, position)
        values (${year}, ${versionId}, ${body.fieldKey}, ${body.label}, ${body.fieldType},
                ${body.required}, ${body.visible}, ${body.position})
        on conflict (template_version_id, field_key) do nothing
        returning id
      `);
      if (!row) throw conflict('a field with that key already exists in this version');

      await writeAudit(tx, {
        actor: principal,
        action: 'template.field.create',
        targetType: 'template_field',
        targetId: row.id,
        detail: `Added field ${body.fieldKey} to template version ${version.version}`,
        kind: 'governance',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created.id });
  });

  // -------------------------------------------------------------------------
  // Versions (FR-005)
  // -------------------------------------------------------------------------

  app.get('/api/template/versions', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select tv.id, tv.version, tv.state, tv.note,
             tv.published_at as "publishedAt", u.display_name as "publishedBy",
             (select count(*) from template_fields tf where tf.template_version_id = tv.id)
               as "fieldCount",
             (select count(*) from entities e where e.template_version_id = tv.id)
               as "entityCount"
      from template_versions tv
      left join users u on u.id = tv.published_by
      where tv.fiscal_year = ${year}
      order by tv.version desc
    `),
  );

  /**
   * Start a new draft, copying the latest version's fields so the common case
   * — "change one label" — does not mean retyping the template.
   */
  app.post('/api/template/versions', { config: requires('template.define') }, async (request, reply) => {
    const body = parse(schemas.templateVersionCreateSchema, request.body);
    const principal = principalOf(request);

    const created = await db.transaction(async (tx) => {
      const open = await tx.one<{ version: number }>(sql`
        select version from template_versions
        where fiscal_year = ${year} and state = 'draft' limit 1
      `);
      // One draft at a time. Two open drafts would make "the next version"
      // ambiguous, and publishing order would decide the answer silently.
      if (open) {
        throw new AppError('conflict', `version ${open.version} is still a draft`, {
          version: `template version ${open.version} is still a draft — publish or discard it first`,
        });
      }

      const previous = await tx.one<{ id: string; version: number }>(sql`
        select id, version from template_versions
        where fiscal_year = ${year} order by version desc limit 1
      `);
      const nextVersion = (previous?.version ?? 0) + 1;

      const row = await tx.one<{ id: string }>(sql`
        insert into template_versions (fiscal_year, version, state, note)
        values (${year}, ${nextVersion}, 'draft', ${body.note ?? null})
        returning id
      `);

      if (previous) {
        await tx.query(sql`
          insert into template_fields
            (fiscal_year, template_version_id, field_key, label, field_type, required, visible, position)
          select ${year}, ${row!.id}, field_key, label, field_type, required, visible, position
          from template_fields where template_version_id = ${previous.id}
        `);
      }

      await writeAudit(tx, {
        actor: principal,
        action: 'template.version.create',
        targetType: 'template_version',
        targetId: row!.id,
        detail: `Opened draft template version ${nextVersion}`,
        kind: 'governance',
        request,
      });
      return { id: row!.id, version: nextVersion };
    });

    return reply.status(201).send(created);
  });

  /**
   * FR-005: publishing is an audited event, and in-flight budgets keep the
   * version they were started on. The audit detail records how many entities
   * stayed behind, because that number is the whole point of the requirement.
   */
  app.post('/api/template/versions/:versionId/publish', { config: requires('template.publish') }, async (request) => {
    const { versionId } = parse(z.object({ versionId: schemas.uuid }), request.params);
    const principal = principalOf(request);

    return db.transaction(async (tx) => {
      const version = await tx.one<{ version: number; state: string }>(sql`
        select version, state from template_versions
        where id = ${versionId} and fiscal_year = ${year}
        for update
      `);
      if (!version) throw notFound('template version does not exist');
      if (version.state === 'published') throw conflict('version is already published');

      const fields = await tx.one<{ count: string }>(sql`
        select count(*)::text as count from template_fields
        where template_version_id = ${versionId}
      `);
      if (Number(fields?.count ?? 0) === 0) {
        throw conflict('a template version must have at least one field before it is published');
      }

      await tx.query(sql`
        update template_versions
        set state = 'published', published_by = ${principal.userId}, published_at = now()
        where id = ${versionId}
      `);

      // Entities that have not started keep tracking the newest version;
      // entities already in flight keep theirs. `state = 'draft'` with no lines
      // is the definition of "not started".
      const adopted = await tx.query<{ id: string }>(sql`
        update entities e
        set template_version_id = ${versionId}
        where e.state = 'draft'
          and not exists (
            select 1 from line_items li where li.entity_id = e.id and li.deleted_at is null
          )
        returning e.id
      `);

      const pinned = await tx.one<{ count: string }>(sql`
        select count(*)::text as count from entities
        where template_version_id is distinct from ${versionId}
      `);

      await writeAudit(tx, {
        actor: principal,
        action: 'template.version.publish',
        targetType: 'template_version',
        targetId: versionId,
        detail:
          `Published template version ${version.version}: ` +
          `${adopted.length} not-yet-started entities adopted it, ` +
          `${pinned?.count ?? 0} in-flight entities kept their version (FR-005)`,
        kind: 'governance',
        request,
      });

      return { version: version.version, adopted: adopted.length, retained: Number(pinned?.count ?? 0) };
    });
  });

  // -------------------------------------------------------------------------
  // Threshold and categories (FR-003, FR-004)
  // -------------------------------------------------------------------------

  app.post('/api/template/threshold', { config: requires('template.define') }, async (request) => {
    const { amount } = parse(z.object({ amount: schemas.moneyString }), request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update cycles set approval_threshold_eur = ${amount}, updated_at = now()
        where fiscal_year = ${year}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'template.threshold',
        targetType: 'cycle',
        targetId: null,
        detail: `Approval threshold set to ${amount} EUR`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  app.post('/api/categories', { config: requires('template.define') }, async (request, reply) => {
    const body = parse(
      z.object({
        name: schemas.shortText(120),
        costType: schemas.costType,
        position: z.number().int().min(0).max(500),
      }),
      request.body,
    );
    const principal = principalOf(request);

    const created = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into categories (name, cost_type, position)
        values (${body.name}, ${body.costType}, ${body.position})
        returning id
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'category.create',
        targetType: 'category',
        targetId: row?.id ?? null,
        detail: `Created category "${body.name}"`,
        kind: 'governance',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created?.id });
  });
}

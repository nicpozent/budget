/**
 * Workflow (FR-050..FR-057).
 *
 * Segregation of duties (SEC-012) is enforced in three places, on purpose:
 * a CHECK constraint in the schema, an explicit comparison here, and a test
 * that asserts a submitter cannot approve their own submission. The constraint
 * is the one that cannot be bypassed; the check here produces a useful error
 * instead of a database exception.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requireReadEntity, requireWriteEntity, requires } from '../http/guard.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { assertEntityEditable, evaluateValidationRules } from '../services/editability.ts';
import { visibleEntityIds } from './meta.ts';

export async function registerWorkflowRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;

  /** FR-057 preview: what would block this submission right now. */
  app.get('/api/entities/:entityId/validation', { config: authenticatedRoute }, async (request) => {
    const { entityId } = parse(z.object({ entityId: schemas.uuid }), request.params);
    requireReadEntity(request, entityId);
    return { violations: await evaluateValidationRules(db, entityId, year) };
  });

  /** FR-050 submit. */
  app.post('/api/entities/:entityId/submit', { config: requires('budget.submit') }, async (request) => {
    const { entityId } = parse(z.object({ entityId: schemas.uuid }), request.params);
    const principal = requireWriteEntity(request, entityId);
    await assertEntityEditable(db, { entityId, fiscalYear: year, region: config.RESIDENCY_REGION });

    // FR-057: a blocking rule prevents submission server-side, not merely in
    // the UI. This is the check that counts.
    const violations = await evaluateValidationRules(db, entityId, year);
    const blocking = violations.filter((v) => v.severity === 'blocking');
    if (blocking.length > 0) {
      throw new AppError(
        'conflict',
        'blocking validation rules',
        Object.fromEntries(blocking.map((v) => [v.code, v.description])),
      );
    }

    const submission = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into submissions (entity_id, fiscal_year, submitted_by)
        values (${entityId}, ${year}, ${principal.userId})
        returning id
      `);
      await tx.query(sql`update entities set state = 'submitted' where id = ${entityId}`);
      await writeAudit(tx, {
        actor: principal,
        action: 'budget.submit',
        targetType: 'entity',
        targetId: entityId,
        entityId,
        detail: `Submitted FY${year} budget for review`,
        kind: 'workflow',
        request,
      });
      return row;
    });

    return { submissionId: submission?.id, warnings: violations.filter((v) => v.severity === 'warning') };
  });

  /** FR-052 CFO decision on a whole submission. */
  app.post(
    '/api/submissions/:submissionId/decision',
    { config: requires('submission.decide') },
    async (request) => {
      const { submissionId } = parse(z.object({ submissionId: schemas.uuid }), request.params);
      const body = parse(schemas.submissionDecisionSchema, request.body);
      const principal = principalOf(request);

      const submission = await db.one<{ entity_id: string; submitted_by: string; state: string }>(sql`
        select entity_id, submitted_by, state from submissions where id = ${submissionId}
      `);
      if (!submission) throw notFound('submission does not exist');
      if (submission.state !== 'submitted' && submission.state !== 'changes_requested') {
        throw conflict('submission has already been decided');
      }

      // SEC-012, stated here so the caller gets a meaningful message rather
      // than a constraint violation.
      if (submission.submitted_by === principal.userId) {
        throw forbidden('the actor who submits cannot be the actor who approves (SEC-012)');
      }

      const nextState =
        body.decision === 'approve' ? 'approved'
        : body.decision === 'reject' ? 'rejected'
        : 'changes_requested';

      const entityState =
        body.decision === 'approve' ? 'approved'
        : body.decision === 'reject' ? 'draft'
        : 'changes_requested';

      await db.transaction(async (tx) => {
        await tx.query(sql`
          update submissions
          set state = ${nextState}, decided_by = ${principal.userId},
              decided_at = now(), comment = ${body.comment}
          where id = ${submissionId}
        `);
        await tx.query(sql`
          update entities set state = ${entityState} where id = ${submission.entity_id}
        `);
        await writeAudit(tx, {
          actor: principal,
          action: `submission.${body.decision}`,
          targetType: 'submission',
          targetId: submissionId,
          entityId: submission.entity_id,
          // FR-052: the free-text request is part of the record and is visible
          // to the owner, so it belongs in the audit detail too.
          detail: `${body.decision}: ${body.comment}`,
          kind: 'approval',
          request,
        });
      });

      return { state: nextState };
    },
  );

  /** FR-053 per-line decision. */
  app.post(
    '/api/submissions/:submissionId/lines/:lineId/decision',
    { config: requires('submission.decideLine') },
    async (request) => {
      const { submissionId, lineId } = parse(
        z.object({ submissionId: schemas.uuid, lineId: schemas.uuid }),
        request.params,
      );
      const body = parse(schemas.lineDecisionSchema, request.body);
      const principal = principalOf(request);

      const context = await db.one<{ entity_id: string; submitted_by: string }>(sql`
        select s.entity_id, s.submitted_by
        from submissions s
        join line_items li on li.id = ${lineId} and li.entity_id = s.entity_id
        where s.id = ${submissionId}
      `);
      // A line that does not belong to this submission's entity resolves to
      // "not found" rather than revealing that the line exists elsewhere.
      if (!context) throw notFound('line is not part of this submission');
      if (context.submitted_by === principal.userId) {
        throw forbidden('the actor who submits cannot decide their own lines (SEC-012)');
      }

      await db.transaction(async (tx) => {
        await tx.query(sql`
          insert into submission_line_decisions
            (submission_id, line_id, decision, comment, decided_by)
          values (${submissionId}, ${lineId}, ${body.decision}, ${body.comment ?? null},
                  ${principal.userId})
          on conflict (submission_id, line_id)
          do update set decision = excluded.decision, comment = excluded.comment,
                        decided_by = excluded.decided_by, decided_at = now()
        `);
        await writeAudit(tx, {
          actor: principal,
          action: `submission.line.${body.decision}`,
          targetType: 'line_item',
          targetId: lineId,
          entityId: context.entity_id,
          detail: body.comment ? `${body.decision}: ${body.comment}` : body.decision,
          kind: 'approval',
          request,
        });
      });

      return { ok: true };
    },
  );

  /** FR-053 approve every line in one action. */
  app.post(
    '/api/submissions/:submissionId/approve-all-lines',
    { config: requires('submission.decideLine') },
    async (request) => {
      const { submissionId } = parse(z.object({ submissionId: schemas.uuid }), request.params);
      const principal = principalOf(request);

      const submission = await db.one<{ entity_id: string; submitted_by: string }>(sql`
        select entity_id, submitted_by from submissions where id = ${submissionId}
      `);
      if (!submission) throw notFound('submission does not exist');
      if (submission.submitted_by === principal.userId) {
        throw forbidden('the actor who submits cannot decide their own lines (SEC-012)');
      }

      const affected = await db.transaction(async (tx) => {
        const rows = await tx.query<{ line_id: string }>(sql`
          insert into submission_line_decisions
            (submission_id, line_id, decision, decided_by)
          select ${submissionId}, li.id, 'approved', ${principal.userId}
          from line_items li
          where li.entity_id = ${submission.entity_id} and li.deleted_at is null
          on conflict (submission_id, line_id)
          do update set decision = 'approved', decided_by = excluded.decided_by,
                        decided_at = now()
          returning line_id
        `);
        await writeAudit(tx, {
          actor: principal,
          action: 'submission.line.approve_all',
          targetType: 'submission',
          targetId: submissionId,
          entityId: submission.entity_id,
          detail: `Approved all ${rows.length} lines`,
          kind: 'approval',
          request,
        });
        return rows.length;
      });

      return { affected };
    },
  );

  /** FR-052 the CFO's queue, and the owner's view of their own submissions. */
  app.get('/api/submissions', { config: authenticatedRoute }, async (request) => {
    const ids = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    if (ids.length === 0) return [];
    return db.query(sql`
      select s.id, s.entity_id as "entityId", e.code as "entityCode", e.name as "entityName",
             s.fiscal_year as "fiscalYear", s.state, s.submitted_at as "submittedAt",
             s.comment, coalesce(u.display_name, 'Removed user') as "submittedBy",
             (select count(*) from submission_line_decisions d
               where d.submission_id = s.id and d.decision = 'approved') as "linesApproved",
             (select count(*) from submission_line_decisions d
               where d.submission_id = s.id and d.decision = 'rejected') as "linesRejected"
      from submissions s
      join entities e on e.id = s.entity_id
      join users u on u.id = s.submitted_by
      where s.entity_id = any(${ids}::uuid[]) and s.fiscal_year = ${year}
      order by s.submitted_at desc
    `);
  });

  // -------------------------------------------------------------------------
  // Cycle (FR-055..FR-057). CFO and Finance Manager only.
  // -------------------------------------------------------------------------

  app.post('/api/cycle/phase', { config: requires('cycle.phase') }, async (request) => {
    const { phase } = parse(z.object({ phase: schemas.cyclePhase }), request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update cycles set phase = ${phase}, updated_at = now() where fiscal_year = ${year}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'cycle.phase',
        targetType: 'cycle',
        targetId: null,
        detail: `Cycle phase moved to ${phase}`,
        kind: 'workflow',
        request,
      });
    });

    return { phase };
  });

  app.post('/api/cycle/lock', { config: requires('cycle.phase') }, async (request) => {
    const body = parse(
      z.object({
        lockEnabled: z.boolean(),
        lockDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      }),
      request.body,
    );
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update cycles set lock_enabled = ${body.lockEnabled}, lock_date = ${body.lockDate},
                          updated_at = now()
        where fiscal_year = ${year}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'cycle.lock',
        targetType: 'cycle',
        targetId: null,
        detail: body.lockEnabled
          ? `Submission lock enabled for ${body.lockDate}`
          : 'Submission lock disabled',
        kind: 'workflow',
        request,
      });
    });

    return { ok: true };
  });

  /** FR-056 a per-entity exception reopens submission and is audited. */
  app.post('/api/cycle/exceptions', { config: requires('cycle.exception') }, async (request, reply) => {
    const body = parse(
      z.object({
        entityId: schemas.uuid,
        reason: schemas.shortText(500),
        expiresInDays: z.number().int().min(1).max(90),
      }),
      request.body,
    );
    const principal = principalOf(request);

    const created = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into cycle_exceptions (fiscal_year, entity_id, reason, granted_by, expires_at)
        values (${year}, ${body.entityId}, ${body.reason}, ${principal.userId},
                now() + make_interval(days => ${body.expiresInDays}))
        returning id
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'cycle.exception.grant',
        targetType: 'entity',
        targetId: body.entityId,
        entityId: body.entityId,
        detail: `Late-edit exception for ${body.expiresInDays} days: ${body.reason}`,
        kind: 'workflow',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created?.id });
  });

  app.get('/api/cycle/exceptions', { config: authenticatedRoute }, async (request) => {
    const ids = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    if (ids.length === 0) return [];
    return db.query(sql`
      select ce.id, ce.entity_id as "entityId", e.code as "entityCode", ce.reason,
             ce.granted_at as "grantedAt", ce.expires_at as "expiresAt",
             coalesce(u.display_name, 'Removed user') as "grantedBy"
      from cycle_exceptions ce
      join entities e on e.id = ce.entity_id
      join users u on u.id = ce.granted_by
      where ce.fiscal_year = ${year} and ce.entity_id = any(${ids}::uuid[])
      order by ce.granted_at desc
    `);
  });

  app.get('/api/validation-rules', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select id, code, description, severity, enabled from validation_rules order by code
    `),
  );

  app.patch('/api/validation-rules/:ruleId', { config: requires('cycle.rules') }, async (request) => {
    const { ruleId } = parse(z.object({ ruleId: schemas.uuid }), request.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      const rule = await tx.one<{ code: string }>(sql`
        update validation_rules set enabled = ${enabled} where id = ${ruleId} returning code
      `);
      if (!rule) throw notFound('rule does not exist');
      await writeAudit(tx, {
        actor: principal,
        action: 'cycle.rule.toggle',
        targetType: 'validation_rule',
        targetId: ruleId,
        detail: `Rule ${rule.code} ${enabled ? 'enabled' : 'disabled'}`,
        kind: 'workflow',
        request,
      });
    });

    return { ok: true };
  });

  /** FR-054 in-app reminders with a sent log. */
  app.post('/api/reminders', { config: requires('template.define') }, async (request, reply) => {
    const body = parse(schemas.reminderSchema, request.body);
    const principal = principalOf(request);

    const created = await db.transaction(async (tx) => {
      const row = await tx.one<{ id: string }>(sql`
        insert into reminders (target_role, message, sent_by)
        values (${body.targetRole}, ${body.message}, ${principal.userId})
        returning id
      `);
      await writeAudit(tx, {
        actor: principal,
        action: 'reminder.send',
        targetType: 'reminder',
        targetId: row?.id ?? null,
        detail: `Reminder sent to ${body.targetRole}`,
        kind: 'workflow',
        request,
      });
      return row;
    });

    return reply.status(201).send({ id: created?.id });
  });

  app.get('/api/reminders', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select r.id, r.target_role as "targetRole", r.message, r.sent_at as "sentAt",
             coalesce(u.display_name, 'Removed user') as "sentBy"
      from reminders r join users u on u.id = r.sent_by
      order by r.sent_at desc limit 100
    `),
  );

  /** FR-031 the Finance Manager approves or rejects each capex asset life. */
  app.post('/api/lines/:lineId/asset-life', { config: requires('capex.approveAssetLife') }, async (request) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);
    const body = parse(
      z.object({
        years: z.number().int().min(1).max(40),
        decision: z.enum(['approved', 'rejected']),
      }),
      request.body,
    );
    const principal = principalOf(request);

    const line = await db.one<{ entity_id: string; cost_type: string }>(sql`
      select entity_id, cost_type from line_items where id = ${lineId} and deleted_at is null
    `);
    if (!line) throw notFound('line does not exist');
    if (line.cost_type !== 'capex') throw badRequest('line is not capex');

    await db.transaction(async (tx) => {
      await tx.query(sql`
        update line_items
        set asset_life_years = ${body.years}, asset_life_status = ${body.decision},
            asset_life_decided_by = ${principal.userId}, version = version + 1
        where id = ${lineId}
      `);
      await writeAudit(tx, {
        actor: principal,
        action: `capex.asset_life.${body.decision}`,
        targetType: 'line_item',
        targetId: lineId,
        entityId: line.entity_id,
        detail: `Asset life ${body.years} years ${body.decision}`,
        kind: 'approval',
        request,
      });
    });

    return { ok: true };
  });
}

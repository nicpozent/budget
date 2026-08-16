/**
 * Configurable approval stages (FR-051).
 *
 * Configuration is the Administrator's (SPEC §4 gives them the approval
 * workflow); deciding a stage belongs to whoever the stage names. Keeping those
 * two apart is the point: an approver who could redraw their own gate would
 * make the gate meaningless.
 *
 * The gating logic itself is in `services/approval.ts` so it can be tested
 * without a request.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requireReadEntity, requires } from '../http/guard.ts';
import { AppError, conflict, forbidden, notFound, type ErrorCode } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import {
  entityStateFor,
  isStageApproverRole,
  outcomeOf,
  stageProgress,
  submissionTotalEur,
} from '../services/approval.ts';

/**
 * Workflow refusals carry their reason in `fields`.
 *
 * The generic messages in `errors.ts` exist so a refusal cannot be used to probe
 * for records the caller may not see. That reasoning does not apply here: which
 * stage is waiting, and which role it needs, is already readable by anyone who
 * can read the submission (`GET /api/submissions/:id/stages`). Returning the
 * generic "the record changed since you loaded it" instead would be actively
 * misleading — nothing changed, and reloading will not help.
 *
 * `fields` is the sanctioned channel for detail we generate ourselves; no
 * database or driver text passes through it.
 */
function stageError(
  code: ErrorCode,
  internalMessage: string,
  fields: Record<string, string>,
): AppError {
  return new AppError(code, internalMessage, fields);
}

export async function registerApprovalRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;

  // -------------------------------------------------------------------------
  // Configuration (Administrator)
  // -------------------------------------------------------------------------

  app.get('/api/approval-stages', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select id, position, name, required_role as "requiredRole",
             min_amount_eur::text as "minAmountEur", enabled
      from approval_stages where fiscal_year = ${year} order by position
    `),
  );

  app.post('/api/approval-stages', { config: requires('approval.configure') }, async (request, reply) => {
    const body = parse(schemas.approvalStageSchema, request.body);
    const principal = principalOf(request);

    // The role must be one that actually holds `submission.decideStage`,
    // otherwise the stage would be unactionable and every submission above its
    // threshold would wedge. Refusing here makes that state unreachable.
    if (!isStageApproverRole(body.requiredRole)) {
      throw stageError('bad_request', `role ${body.requiredRole} cannot act as an approval stage`, {
        requiredRole: `${body.requiredRole} does not hold submission.decideStage`,
      });
    }

    const created = await db.transaction(async (tx) => {
      const next = await tx.one<{ position: number }>(sql`
        select coalesce(max(position), 0) + 1 as position
        from approval_stages where fiscal_year = ${year}
      `);
      const row = await tx.one<{ id: string }>(sql`
        insert into approval_stages
          (fiscal_year, position, name, required_role, min_amount_eur, enabled)
        values (${year}, ${next!.position}, ${body.name}, ${body.requiredRole},
                ${body.minAmountEur}, ${body.enabled})
        on conflict (fiscal_year, name) do nothing
        returning id
      `);
      if (!row) throw conflict('a stage with that name already exists this year');

      await writeAudit(tx, {
        actor: principal,
        action: 'approval.stage.create',
        targetType: 'approval_stage',
        targetId: row.id,
        detail:
          `Stage "${body.name}" at position ${next!.position}: ` +
          `${body.requiredRole} decides, applies at or above ${body.minAmountEur} EUR`,
        kind: 'governance',
        request,
      });
      return { id: row.id, position: next!.position };
    });

    return reply.status(201).send(created);
  });

  app.patch('/api/approval-stages/:stageId', { config: requires('approval.configure') }, async (request) => {
    const { stageId } = parse(z.object({ stageId: schemas.uuid }), request.params);
    const body = parse(schemas.approvalStageSchema.partial(), request.body);
    const principal = principalOf(request);

    if (body.requiredRole !== undefined && !isStageApproverRole(body.requiredRole)) {
      throw stageError('bad_request', `role ${body.requiredRole} cannot act as an approval stage`, {
        requiredRole: `${body.requiredRole} does not hold submission.decideStage`,
      });
    }

    await db.transaction(async (tx) => {
      const updated = await tx.one<{ name: string }>(sql`
        update approval_stages set
          name           = coalesce(${body.name ?? null}, name),
          required_role  = coalesce(${body.requiredRole ?? null}, required_role),
          min_amount_eur = coalesce(${body.minAmountEur ?? null}, min_amount_eur),
          enabled        = coalesce(${body.enabled ?? null}, enabled)
        where id = ${stageId} and fiscal_year = ${year}
        returning name
      `);
      if (!updated) throw notFound('stage does not exist');

      await writeAudit(tx, {
        actor: principal,
        action: 'approval.stage.update',
        targetType: 'approval_stage',
        targetId: stageId,
        detail: `Updated stage "${updated.name}"`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  /**
   * Reorder is a whole-list operation. Positions are unique per year, so
   * shuffling them one at a time would collide; the update runs inside one
   * transaction with positions offset out of the way first.
   */
  app.put('/api/approval-stages/order', { config: requires('approval.configure') }, async (request) => {
    const body = parse(schemas.approvalStageOrderSchema, request.body);
    const principal = principalOf(request);

    await db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(sql`
        select id from approval_stages where fiscal_year = ${year} order by position
      `);
      const wanted = new Set(body.stageIds);
      if (wanted.size !== body.stageIds.length) {
        throw stageError('bad_request', 'duplicate stage in ordering', {
          stageIds: 'the ordering lists a stage more than once',
        });
      }
      // A partial reorder would silently leave stages at stale positions, so
      // the request must name every stage exactly once.
      if (existing.length !== body.stageIds.length || !existing.every((s) => wanted.has(s.id))) {
        throw stageError('bad_request', 'incomplete stage ordering', {
          stageIds: 'the ordering must list every stage for this year exactly once',
        });
      }

      // Two passes: park everything above the range, then place it. One pass
      // would violate the (fiscal_year, position) unique constraint mid-flight.
      await tx.query(sql`
        update approval_stages set position = position + 1000 where fiscal_year = ${year}
      `);
      for (const [index, id] of body.stageIds.entries()) {
        await tx.query(sql`
          update approval_stages set position = ${index + 1}
          where id = ${id} and fiscal_year = ${year}
        `);
      }

      await writeAudit(tx, {
        actor: principal,
        action: 'approval.stage.reorder',
        targetType: 'cycle',
        targetId: null,
        detail: `Reordered ${body.stageIds.length} approval stages`,
        kind: 'governance',
        request,
      });
    });

    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Progress and decisions
  // -------------------------------------------------------------------------

  app.get('/api/submissions/:submissionId/stages', { config: authenticatedRoute }, async (request) => {
    const { submissionId } = parse(z.object({ submissionId: schemas.uuid }), request.params);

    const submission = await db.one<{ entity_id: string }>(sql`
      select entity_id from submissions where id = ${submissionId}
    `);
    if (!submission) throw notFound('submission does not exist');
    requireReadEntity(request, submission.entity_id);

    return {
      totalEur: await submissionTotalEur(db, submissionId),
      stages: await stageProgress(db, submissionId),
    };
  });

  /**
   * Record a decision at one stage. Three checks, in order: the stage must be
   * the one waiting, the caller's role must be the one the stage names, and the
   * caller must not be the submitter. The last is also a database trigger, so
   * the check here exists to produce a useful message rather than to be the
   * control.
   */
  app.post('/api/submissions/:submissionId/stage-decision', { config: requires('submission.decideStage') }, async (request) => {
    const { submissionId } = parse(z.object({ submissionId: schemas.uuid }), request.params);
    const body = parse(schemas.stageDecisionSchema, request.body);
    const principal = principalOf(request);

    const submission = await db.one<{ entity_id: string; submitted_by: string; state: string }>(sql`
      select entity_id, submitted_by, state from submissions where id = ${submissionId}
    `);
    if (!submission) throw notFound('submission does not exist');
    requireReadEntity(request, submission.entity_id);
    if (submission.state === 'approved' || submission.state === 'rejected') {
      throw conflict('submission has already been decided');
    }
    if (submission.submitted_by === principal.userId) {
      throw forbidden('the actor who submits cannot decide a stage on it (SEC-012)');
    }

    const progress = await stageProgress(db, submissionId);
    const stage = progress.find((s) => s.id === body.stageId);
    if (!stage) throw notFound('stage does not apply to this submission');
    if (!stage.applies) {
      throw stageError('conflict', `stage ${stage.name} does not apply`, {
        stage: `"${stage.name}" applies only at or above ${stage.minAmountEur} EUR`,
      });
    }
    if (!stage.isCurrent) {
      throw stageError('conflict', `stage ${stage.name} is not current`, {
        stage: stage.decision
          ? `"${stage.name}" has already been decided`
          : `"${stage.name}" is not the current stage — an earlier stage is still waiting`,
      });
    }
    if (stage.requiredRole !== principal.role) {
      throw stageError('forbidden', `stage ${stage.name} needs ${stage.requiredRole}`, {
        stage: `"${stage.name}" must be decided by ${stage.requiredRole}`,
      });
    }

    return db.transaction(async (tx) => {
      await tx.query(sql`
        insert into submission_stage_decisions
          (submission_id, stage_id, decision, comment, decided_by)
        values (${submissionId}, ${body.stageId}, ${body.decision}, ${body.comment ?? null},
                ${principal.userId})
        on conflict (submission_id, stage_id)
        do update set decision = excluded.decision, comment = excluded.comment,
                      decided_by = excluded.decided_by, decided_at = now()
      `);

      // Re-read inside the transaction: the outcome must be computed from what
      // is committed, not from the snapshot taken before the write.
      const updated = await stageProgress(tx, submissionId);
      const outcome = outcomeOf(updated);
      const entityState = entityStateFor(outcome);

      await tx.query(sql`
        update submissions
        set state = ${outcome.state},
            decided_by = ${outcome.state === 'submitted' ? null : principal.userId},
            decided_at = ${outcome.state === 'submitted' ? null : new Date()},
            comment = coalesce(${body.comment ?? null}, comment)
        where id = ${submissionId}
      `);
      await tx.query(sql`
        update entities set state = ${entityState} where id = ${submission.entity_id}
      `);

      await writeAudit(tx, {
        actor: principal,
        action: `approval.stage.${body.decision}`,
        targetType: 'submission',
        targetId: submissionId,
        entityId: submission.entity_id,
        detail:
          `Stage "${stage.name}" ${body.decision}` +
          (body.comment ? `: ${body.comment}` : '') +
          ` — submission is now ${outcome.state}`,
        kind: 'approval',
        request,
      });

      return {
        state: outcome.state,
        awaiting: outcome.state === 'submitted' ? outcome.awaiting.name : null,
      };
    });
  });
}

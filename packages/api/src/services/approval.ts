/**
 * Configurable approval stages (FR-051).
 *
 * A submission passes through the stages configured for its fiscal year, in
 * order. Two conditions decide whether a stage applies to a given submission:
 *
 *   role      — only a principal holding `stage.required_role` may decide it
 *   threshold — the stage applies only when the submission's EUR total is at
 *               or above `stage.min_amount_eur`
 *
 * so a small budget can legitimately skip a stage a large one must pass. A
 * submission is approved when every *applicable* stage has approved, and that
 * conclusion is computed here — not in the UI, and not by trusting a state
 * column a client could set.
 *
 * The stage total is computed in EUR at the FY-locked rate, the same basis the
 * consolidation report uses, so "above €1M" means the same thing in both places.
 */

import { STAGE_APPROVER_ROLES, type Role } from '@spendifre/shared';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';

export interface ApprovalStage {
  id: string;
  position: number;
  name: string;
  requiredRole: Role;
  minAmountEur: string;
  enabled: boolean;
}

export interface StageProgress extends ApprovalStage {
  /** False when the submission total is below this stage's threshold. */
  applies: boolean;
  decision: 'approved' | 'rejected' | 'changes_requested' | null;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
  /** True when every earlier applicable stage has approved and this has not
   *  been decided — i.e. this is the stage waiting on someone right now. */
  isCurrent: boolean;
}

export function isStageApproverRole(role: string): role is Role {
  return (STAGE_APPROVER_ROLES as readonly string[]).includes(role);
}

/** The submission's own entity total for the year, in EUR at the locked rate. */
export async function submissionTotalEur(
  db: Db,
  submissionId: string,
): Promise<string> {
  const row = await db.one<{ total: string }>(sql`
    select coalesce(sum(pa.amount * coalesce(fx.rate, 1)), 0)::text as total
    from submissions s
    join line_items li on li.entity_id = s.entity_id and li.deleted_at is null
    join period_amounts pa
      on pa.line_id = li.id and pa.fiscal_year = s.fiscal_year
     and pa.budget_version = 'working'
    left join fx_rates fx
      on fx.currency = li.currency and fx.fiscal_year = s.fiscal_year
    where s.id = ${submissionId}
  `);
  return row?.total ?? '0';
}

/**
 * Every stage for the submission's year, annotated with whether it applies to
 * this submission and what has been decided. Ordered by position, which is what
 * makes "the current stage" the first undecided applicable one.
 */
export async function stageProgress(
  db: Db,
  submissionId: string,
): Promise<StageProgress[]> {
  const total = await submissionTotalEur(db, submissionId);

  const rows = await db.query<{
    id: string;
    position: number;
    name: string;
    required_role: Role;
    min_amount_eur: string;
    enabled: boolean;
    decision: StageProgress['decision'];
    decided_by: string | null;
    decided_at: string | null;
    comment: string | null;
  }>(sql`
    select st.id, st.position, st.name, st.required_role,
           st.min_amount_eur::text as min_amount_eur, st.enabled,
           d.decision, u.display_name as decided_by,
           d.decided_at::text as decided_at, d.comment
    from submissions s
    join approval_stages st on st.fiscal_year = s.fiscal_year
    left join submission_stage_decisions d
      on d.submission_id = s.id and d.stage_id = st.id
    left join users u on u.id = d.decided_by
    where s.id = ${submissionId}
    order by st.position
  `);

  const totalValue = Number(total);
  let seenUndecided = false;

  return rows.map((r) => {
    // A disabled stage applies to nothing — FR-051 asks for switchable stages,
    // and deleting one would take its decision history with it.
    const applies = r.enabled && totalValue >= Number(r.min_amount_eur);
    const isCurrent = applies && !r.decision && !seenUndecided;
    if (isCurrent) seenUndecided = true;
    return {
      id: r.id,
      position: r.position,
      name: r.name,
      requiredRole: r.required_role,
      minAmountEur: r.min_amount_eur,
      enabled: r.enabled,
      applies,
      decision: r.decision,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      comment: r.comment,
      isCurrent,
    };
  });
}

export type SubmissionOutcome =
  | { state: 'approved' }
  | { state: 'rejected' }
  | { state: 'changes_requested' }
  | { state: 'submitted'; awaiting: StageProgress };

/**
 * What the submission's state should be, given the stage decisions recorded so
 * far. Pure with respect to the database: the caller passes the progress and
 * gets the conclusion, which is what makes it directly testable.
 *
 * Precedence is deliberate. One rejection ends the submission — later stages do
 * not get to overturn an earlier "no" — and a request for changes returns it to
 * the owner even if a later stage has already approved, because the owner is
 * about to change the figures those approvals were given for.
 */
export function outcomeOf(progress: readonly StageProgress[]): SubmissionOutcome {
  const applicable = progress.filter((s) => s.applies);

  if (applicable.some((s) => s.decision === 'rejected')) return { state: 'rejected' };
  if (applicable.some((s) => s.decision === 'changes_requested')) {
    return { state: 'changes_requested' };
  }

  const awaiting = applicable.find((s) => !s.decision);
  if (awaiting) return { state: 'submitted', awaiting };

  // No applicable stage is undecided. If there were no applicable stages at
  // all, the budget is approved by configuration — an administrator who
  // thresholds every stage above a budget's total has said it needs no review.
  return { state: 'approved' };
}

/** The entity state that corresponds to a submission state. */
export function entityStateFor(outcome: SubmissionOutcome): string {
  switch (outcome.state) {
    case 'approved': return 'approved';
    case 'rejected': return 'draft';
    case 'changes_requested': return 'changes_requested';
    default: return 'submitted';
  }
}

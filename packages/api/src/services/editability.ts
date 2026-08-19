/**
 * Whether a budget may be edited right now (INV-5, FR-056, FR-057).
 *
 * This lives server-side and is called by every write path. The UI also greys
 * out a locked grid, but that is presentation: the check that counts is this
 * one, because the client is not trusted to tell us the cycle phase.
 */

import type { ServedScope } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { servedEntityClause } from './residency.ts';
import { forbidden, notFound } from '../http/errors.ts';

export interface EditabilityContext {
  entityId: string;
  fiscalYear: number;
  /** SPEC §9.4 — what this deployment serves. A write to an entity outside
   *  that scope is refused, not merely hidden. */
  scope: ServedScope;
}

export async function assertEntityEditable(
  db: Db,
  { entityId, fiscalYear, scope }: EditabilityContext,
): Promise<void> {
  const row = await db.one<{
    state: string;
    phase: string;
    lock_enabled: boolean;
    lock_date: string | null;
    has_exception: boolean;
  }>(sql`
    select
      e.state,
      c.phase,
      c.lock_enabled,
      c.lock_date::text as lock_date,
      exists (
        select 1 from cycle_exceptions ce
        where ce.entity_id = e.id
          and ce.fiscal_year = ${fiscalYear}
          and ce.expires_at > now()
      ) as has_exception
    from entities e
    cross join cycles c
    where e.id = ${entityId} and c.fiscal_year = ${fiscalYear}
      and ${servedEntityClause(scope)}
  `);

  if (!row) throw notFound('entity or cycle does not exist in this region');

  // INV-5: an approved budget is immutable. Reopening requires an exception
  // granted by the CFO or Finance Manager, which is itself audited.
  if (row.state === 'approved' || row.state === 'locked') {
    if (!row.has_exception) {
      throw forbidden('budget is approved and immutable without an exception (INV-5)');
    }
  }

  if (row.phase === 'locked' && !row.has_exception) {
    throw forbidden('cycle is locked');
  }

  // FR-056: the lock date closes submission; a per-entity exception reopens it.
  if (row.lock_enabled && row.lock_date) {
    const lockDate = new Date(`${row.lock_date}T23:59:59Z`);
    if (Date.now() > lockDate.getTime() && !row.has_exception) {
      throw forbidden('the submission lock date has passed');
    }
  }
}

export interface RuleViolation {
  code: string;
  description: string;
  severity: 'blocking' | 'warning';
  lineIds: string[];
}

/**
 * FR-057. Rules are evaluated here, on the server, and a blocking violation
 * refuses the submission — the UI's copy of this logic is a convenience, not
 * the control.
 */
export async function evaluateValidationRules(
  db: Db,
  entityId: string,
  fiscalYear: number,
): Promise<RuleViolation[]> {
  const rules = await db.query<{ code: string; description: string; severity: 'blocking' | 'warning' }>(
    sql`select code, description, severity from validation_rules where enabled order by code`,
  );

  const violations: RuleViolation[] = [];

  for (const rule of rules) {
    let offending: { id: string }[] = [];

    // Each rule is a named query rather than a stored expression. A rule engine
    // that evaluated user-authored expressions would be a code-injection
    // surface; an admin toggling a rule from a fixed set is not.
    switch (rule.code) {
      case 'cost_centre_required':
        offending = await db.query<{ id: string }>(sql`
          select li.id from line_items li
          where li.entity_id = ${entityId} and li.deleted_at is null
            and li.cost_centre_id is null
        `);
        break;

      case 'cost_centre_approved':
        offending = await db.query<{ id: string }>(sql`
          select li.id from line_items li
          left join cost_centres cc on cc.id = li.cost_centre_id
          where li.entity_id = ${entityId} and li.deleted_at is null
            and li.cost_centre_id is not null and cc.status <> 'approved'
        `);
        break;

      case 'no_zero_lines':
        offending = await db.query<{ id: string }>(sql`
          select li.id from line_items li
          where li.entity_id = ${entityId} and li.deleted_at is null
            and coalesce((
              select sum(pa.amount) from period_amounts pa
              where pa.line_id = li.id and pa.fiscal_year = ${fiscalYear}
                and pa.budget_version = 'working'
            ), 0) = 0
            and li.driver_key is null
        `);
        break;

      case 'justification_above_threshold':
        offending = await db.query<{ id: string }>(sql`
          select li.id from line_items li
          join cycles c on c.fiscal_year = ${fiscalYear}
          left join fx_rates fx
            on fx.currency = li.currency and fx.fiscal_year = ${fiscalYear}
          where li.entity_id = ${entityId} and li.deleted_at is null
            and coalesce(li.justification, '') = ''
            and coalesce((
              select sum(pa.amount) from period_amounts pa
              where pa.line_id = li.id and pa.fiscal_year = ${fiscalYear}
                and pa.budget_version = 'working'
            ), 0) * coalesce(fx.rate, 1) > c.approval_threshold_eur
        `);
        break;

      case 'capex_asset_life_approved':
        offending = await db.query<{ id: string }>(sql`
          select li.id from line_items li
          where li.entity_id = ${entityId} and li.deleted_at is null
            and li.cost_type = 'capex'
            and coalesce(li.asset_life_status, 'pending') <> 'approved'
        `);
        break;

      default:
        // An unknown rule code is a configuration error. Skipping it silently
        // would mean a rule someone believes is enforced quietly is not, so it
        // is reported as a warning rather than ignored.
        violations.push({
          code: rule.code,
          description: `Rule "${rule.code}" has no implementation and was not evaluated`,
          severity: 'warning',
          lineIds: [],
        });
        continue;
    }

    if (offending.length > 0) {
      violations.push({
        code: rule.code,
        description: rule.description,
        severity: rule.severity,
        lineIds: offending.map((o) => o.id),
      });
    }
  }

  return violations;
}

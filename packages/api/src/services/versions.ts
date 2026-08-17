/**
 * Budget versions and scenarios (FR-080).
 *
 * SPEC §11 defers this out of v1 and asks only that the schema not preclude it.
 * It is built here at the product owner's request; migration 008 is where the
 * dimension stopped being a free-text column and became a table with a key, a
 * kind and a lock.
 *
 * Three rules shape the module:
 *
 *   A version is group-wide, not per entity. A scenario that existed for some
 *   entities and not others would make a consolidation mean different things in
 *   different rows, and INV-4 would hold arithmetically while the number
 *   answered no question anyone asked.
 *
 *   Copying is a set operation. Six hundred lines times twelve periods is
 *   7,000 rows; doing that a row at a time would make creating a scenario feel
 *   like an import job.
 *
 *   Nothing here recomputes a total. Every figure a version reports comes back
 *   through the same fold in `budget.ts`, with `budgetVersion` as an argument.
 *   That is the whole reason the version dimension was cheap to add.
 */

import { Money, WORKING_VERSION } from '@spendifre/shared';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { conflict, notFound } from '../http/errors.ts';
import { loadGroupedTotals } from './budget.ts';

export const VERSION_KINDS = ['working', 'baseline', 'scenario', 'forecast'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

/** Kinds a caller may create. `working` is created with the cycle and is unique. */
export const CREATABLE_KINDS = ['baseline', 'scenario', 'forecast'] as const;

export interface BudgetVersion {
  fiscalYear: number;
  key: string;
  label: string;
  kind: VersionKind;
  description: string | null;
  locked: boolean;
  copiedFrom: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  lockedAt: string | null;
  /** Rows in `period_amounts` carrying this version. */
  amountCount: number;
}

interface VersionRow {
  fiscal_year: number;
  key: string;
  label: string;
  kind: VersionKind;
  description: string | null;
  locked: boolean;
  copied_from: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  locked_at: string | null;
  amount_count: string;
}

const toVersion = (r: VersionRow): BudgetVersion => ({
  fiscalYear: r.fiscal_year,
  key: r.key,
  label: r.label,
  kind: r.kind,
  description: r.description,
  locked: r.locked,
  copiedFrom: r.copied_from,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  createdAt: r.created_at,
  lockedAt: r.locked_at,
  amountCount: Number(r.amount_count),
});

const VERSION_SELECT = sql`
  select bv.fiscal_year, bv.key, bv.label, bv.kind, bv.description, bv.locked,
         bv.copied_from, bv.created_by, u.display_name as created_by_name,
         bv.created_at::text as created_at, bv.locked_at::text as locked_at,
         (select count(*) from period_amounts pa
           where pa.fiscal_year = bv.fiscal_year
             and pa.budget_version = bv.key)::text as amount_count
  from budget_versions bv
  left join users u on u.id = bv.created_by
`;

export async function listVersions(db: Db, fiscalYear: number): Promise<BudgetVersion[]> {
  const rows = await db.query<VersionRow>(sql`
    ${VERSION_SELECT}
    where bv.fiscal_year = ${fiscalYear}
    -- Working first, then in creation order. A list that sorted alphabetically
    -- would bury the live plan somewhere in the middle of the scenarios.
    order by (bv.kind = 'working') desc, bv.created_at
  `);
  return rows.map(toVersion);
}

export async function getVersion(
  db: Db,
  fiscalYear: number,
  key: string,
): Promise<BudgetVersion | null> {
  const row = await db.one<VersionRow>(sql`
    ${VERSION_SELECT} where bv.fiscal_year = ${fiscalYear} and bv.key = ${key}
  `);
  return row ? toVersion(row) : null;
}

/** The version a caller may not edit through, whatever else they hold. */
export async function assertVersionWritable(
  db: Db,
  fiscalYear: number,
  key: string,
): Promise<void> {
  const version = await getVersion(db, fiscalYear, key);
  if (!version) throw notFound('no such budget version');
  // The trigger in migration 008 refuses this too. Checking here as well turns
  // a database exception into a 409 with a sentence in it.
  if (version.locked) throw conflict(`version "${version.label}" is locked`);
}

export interface CreateVersionInput {
  fiscalYear: number;
  key: string;
  label: string;
  kind: (typeof CREATABLE_KINDS)[number];
  description: string | null;
  /** Copy every amount from this version. Null creates an empty version. */
  copyFrom: string | null;
  createdBy: string;
}

export interface CreateVersionResult {
  version: BudgetVersion;
  copiedRows: number;
}

export async function createVersion(
  tx: Db,
  input: CreateVersionInput,
): Promise<CreateVersionResult> {
  const existing = await getVersion(tx, input.fiscalYear, input.key);
  if (existing) throw conflict(`a version keyed "${input.key}" already exists for this year`);

  if (input.copyFrom) {
    const source = await getVersion(tx, input.fiscalYear, input.copyFrom);
    if (!source) throw notFound('no such source version');
  }

  await tx.query(sql`
    insert into budget_versions
      (fiscal_year, key, label, kind, description, copied_from, created_by)
    values (${input.fiscalYear}, ${input.key}, ${input.label}, ${input.kind},
            ${input.description}, ${input.copyFrom}, ${input.createdBy})
  `);

  const copiedRows = input.copyFrom
    ? await copyAmounts(tx, input.fiscalYear, input.copyFrom, input.key)
    : 0;

  const version = await getVersion(tx, input.fiscalYear, input.key);
  return { version: version!, copiedRows };
}

/**
 * Copy every stored amount from one version to another, in one statement.
 *
 * Only stored amounts move. A driver-linked line has none — INV-3 computes it
 * from the driver at read time in every version — so a scenario that wants a
 * different headcount changes the driver, not the line. That is the same rule
 * the grid enforces, applied to scenarios.
 */
export async function copyAmounts(
  tx: Db,
  fiscalYear: number,
  from: string,
  to: string,
): Promise<number> {
  const rows = await tx.query<{ line_id: string }>(sql`
    insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
    select line_id, fiscal_year, period, ${to}, amount
    from period_amounts
    where fiscal_year = ${fiscalYear} and budget_version = ${from}
    on conflict (line_id, fiscal_year, period, budget_version)
      do update set amount = excluded.amount, updated_at = now()
    returning line_id
  `);
  return rows.length;
}

/**
 * Rebase a forecast version: recorded spend for the periods that have closed,
 * the working plan for the ones that have not.
 *
 * This is the rolling part of a rolling forecast, and it is deliberately an
 * explicit action rather than a view. A forecast someone has adjusted by hand
 * should not silently revert the next time a period closes; rebasing is how
 * they ask for it to be redrawn, and it is audited with the count.
 *
 * As with `copyAmounts`, driver-linked lines are untouched: their figure comes
 * from the driver in every version, so a forecast moves them by moving the
 * driver.
 */
export async function rebaseForecast(
  tx: Db,
  fiscalYear: number,
  key: string,
  elapsedPeriods: number,
): Promise<{ closedPeriods: number; rows: number }> {
  const rows = await tx.query<{ line_id: string }>(sql`
    insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
    select w.line_id, w.fiscal_year, w.period, ${key},
           case when w.period <= ${elapsedPeriods}
                then coalesce(a.amount, 0)
                else w.amount
           end
    from period_amounts w
    left join actuals a
      on a.line_id = w.line_id
     and a.fiscal_year = w.fiscal_year
     and a.period = w.period
    where w.fiscal_year = ${fiscalYear} and w.budget_version = ${WORKING_VERSION}
    on conflict (line_id, fiscal_year, period, budget_version)
      do update set amount = excluded.amount, updated_at = now()
    returning line_id
  `);
  return { closedPeriods: elapsedPeriods, rows: rows.length };
}

export interface VersionComparisonRow {
  key: string;
  label: string;
  base: Money;
  against: Money;
  delta: Money;
}

export interface VersionComparison {
  base: string;
  against: string;
  total: VersionComparisonRow;
  entities: VersionComparisonRow[];
  categories: VersionComparisonRow[];
}

/**
 * Two versions side by side, grouped the way FR-060 groups.
 *
 * Both sides go through `loadGroupedTotals`, so the comparison is between two
 * evaluations of the same fold rather than between a fold and a stored figure —
 * which is what stops a scenario comparison from being the one place the
 * numbers disagree with the consolidation they came from.
 */
export async function compareVersions(
  db: Db,
  entityIds: readonly string[],
  fiscalYear: number,
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
  base: string,
  against: string,
): Promise<VersionComparison> {
  const load = (version: string) => loadGroupedTotals(
    db, entityIds, [fiscalYear], headcountPlanningEnabled, periodsInYear,
    ['year', 'entity', 'category'], version,
  );

  const [baseRows, againstRows] = [await load(base), await load(against)];

  const combine = (group: 'entity' | 'category'): VersionComparisonRow[] => {
    const merged = new Map<string, VersionComparisonRow>();
    const put = (rows: typeof baseRows, side: 'base' | 'against') => {
      for (const r of rows) {
        if (r.group !== group) continue;
        const entry = merged.get(r.key)
          ?? { key: r.key, label: r.label, base: Money.ZERO, against: Money.ZERO, delta: Money.ZERO };
        entry[side] = r.plan;
        // A row present on one side only still belongs in the comparison: a
        // scenario that drops a whole category is exactly what someone is
        // looking for here.
        entry.label = entry.label || r.label;
        merged.set(r.key, entry);
      }
    };
    put(baseRows, 'base');
    put(againstRows, 'against');
    return [...merged.values()].map((r) => ({ ...r, delta: r.against.subtract(r.base) }));
  };

  const total = (rows: typeof baseRows) =>
    rows.find((r) => r.group === 'year')?.plan ?? Money.ZERO;
  const baseTotal = total(baseRows);
  const againstTotal = total(againstRows);

  return {
    base,
    against,
    total: {
      key: 'total',
      label: 'Group total',
      base: baseTotal,
      against: againstTotal,
      delta: againstTotal.subtract(baseTotal),
    },
    entities: combine('entity'),
    categories: combine('category'),
  };
}

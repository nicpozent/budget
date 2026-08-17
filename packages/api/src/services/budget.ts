/**
 * The budget read model.
 *
 * Two rules shape this whole module:
 *
 *   INV-4 — every aggregate is the sum of its children, in every year. Nothing
 *   here stores or derives a parent figure independently. Category, entity and
 *   group totals are all folds over the same line-level array, which is why the
 *   property test in test/invariants can assert reconciliation generically.
 *
 *   NFR-003 — FX is applied at read time from the FY-locked rate. Amounts are
 *   stored in the line's own currency, so restating a rate restates every
 *   derived figure consistently and history does not need rewriting.
 */

import { Money, WORKING_VERSION, type Currency } from '@spendifre/shared';
import type { Db } from '../db/pool.ts';
import { join, sql, type SqlFragment } from '../db/pool.ts';

export type FxTable = ReadonlyMap<string, string>;

/** EUR per one unit of each currency, for one fiscal year. */
export async function loadFxTable(db: Db, fiscalYear: number): Promise<FxTable> {
  const rows = await db.query<{ currency: string; rate: string }>(sql`
    select currency, rate::text as rate from fx_rates where fiscal_year = ${fiscalYear}
  `);
  const table = new Map<string, string>(rows.map((r) => [r.currency, r.rate]));
  // EUR is the reporting currency and is always 1, whether or not a row exists.
  table.set('EUR', '1');
  return table;
}

export function toEur(amount: Money, currency: string, fx: FxTable): Money {
  const rate = fx.get(currency);
  if (!rate) {
    // A missing rate is a data error, not a reason to guess. Silently treating
    // it as 1 would understate or overstate a consolidation without a trace.
    throw new Error(`no FX rate for ${currency}`);
  }
  return amount.multiplyByRate(rate);
}

/** FR-014: a value typed in EUR is converted back to local before storage. */
export function fromEur(amount: Money, currency: string, fx: FxTable): Money {
  const rate = fx.get(currency);
  if (!rate) throw new Error(`no FX rate for ${currency}`);
  return amount.divideByRate(rate);
}

export interface LineRow {
  id: string;
  entityId: string;
  entityCode: string;
  categoryId: string;
  categoryName: string;
  categoryPosition: number;
  name: string;
  vendor: string | null;
  costCentreId: string | null;
  costCentreCode: string | null;
  costCentreStatus: string | null;
  glAccount: string | null;
  costType: string;
  currency: Currency;
  justification: string | null;
  driverKey: string | null;
  driverRatePerUnit: string | null;
  driverValue: number | null;
  assetLifeYears: number | null;
  assetLifeStatus: string | null;
  version: number;
  /** Local-currency plan per period, keyed by period number. */
  periods: Record<number, string>;
  /** Local-currency recorded spend per period. */
  actuals: Record<number, string>;
}

interface RawLineRow {
  id: string;
  entity_id: string;
  entity_code: string;
  category_id: string;
  category_name: string;
  category_position: number;
  name: string;
  vendor: string | null;
  cost_centre_id: string | null;
  cost_centre_code: string | null;
  cost_centre_status: string | null;
  gl_account: string | null;
  cost_type: string;
  currency: Currency;
  justification: string | null;
  driver_key: string | null;
  driver_rate_per_unit: string | null;
  driver_value: number | null;
  asset_life_years: number | null;
  asset_life_status: string | null;
  version: number;
  periods: { period: number; amount: string }[] | null;
  actuals: { period: number; amount: string }[] | null;
}

/**
 * Loads every line for a set of entities in one query, with its periods and
 * actuals aggregated in the database.
 *
 * NFR-001: this is deliberately one round trip rather than N+1. A 500-line grid
 * is one statement and one pass.
 */
export async function loadLines(
  db: Db,
  entityIds: readonly string[],
  fiscalYear: number,
  budgetVersion: string = WORKING_VERSION,
): Promise<LineRow[]> {
  if (entityIds.length === 0) return [];

  const rows = await db.query<RawLineRow>(sql`
    select
      li.id, li.entity_id, e.code as entity_code,
      li.category_id, c.name as category_name, c.position as category_position,
      li.name, li.vendor, li.cost_centre_id,
      cc.code as cost_centre_code, cc.status as cost_centre_status,
      li.gl_account, li.cost_type, li.currency, li.justification,
      li.driver_key, li.driver_rate_per_unit::text as driver_rate_per_unit,
      d.value as driver_value,
      li.asset_life_years, li.asset_life_status, li.version,
      (
        select coalesce(json_agg(json_build_object('period', pa.period, 'amount', pa.amount::text)), '[]'::json)
        from period_amounts pa
        where pa.line_id = li.id
          and pa.fiscal_year = ${fiscalYear}
          and pa.budget_version = ${budgetVersion}
      ) as periods,
      (
        select coalesce(json_agg(json_build_object('period', a.period, 'amount', a.amount::text)), '[]'::json)
        from actuals a
        where a.line_id = li.id and a.fiscal_year = ${fiscalYear}
      ) as actuals
    from line_items li
    join entities e on e.id = li.entity_id
    join categories c on c.id = li.category_id
    left join cost_centres cc on cc.id = li.cost_centre_id
    left join drivers d
      on d.entity_id = li.entity_id
     and d.driver_key = li.driver_key
     and d.fiscal_year = ${fiscalYear}
    where li.entity_id = any(${[...entityIds]}::uuid[])
      and li.deleted_at is null
    order by c.position, li.name
  `);

  return rows.map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    entityCode: r.entity_code,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryPosition: r.category_position,
    name: r.name,
    vendor: r.vendor,
    costCentreId: r.cost_centre_id,
    costCentreCode: r.cost_centre_code,
    costCentreStatus: r.cost_centre_status,
    glAccount: r.gl_account,
    costType: r.cost_type,
    currency: r.currency,
    justification: r.justification,
    driverKey: r.driver_key,
    driverRatePerUnit: r.driver_rate_per_unit,
    driverValue: r.driver_value,
    assetLifeYears: r.asset_life_years,
    assetLifeStatus: r.asset_life_status,
    version: r.version,
    periods: indexByPeriod(r.periods),
    actuals: indexByPeriod(r.actuals),
  }));
}

function indexByPeriod(rows: { period: number; amount: string }[] | null): Record<number, string> {
  const out: Record<number, string> = {};
  for (const row of rows ?? []) out[row.period] = row.amount;
  return out;
}

/**
 * INV-3. A driver-linked line's amount is computed from the driver value and
 * the rate, never read from storage — so the stored figure can never drift away
 * from the formula, and turning headcount planning off (FR-022) makes the line
 * dormant rather than deleting anything.
 */
export function effectivePeriodAmount(
  line: LineRow,
  period: number,
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
): Money {
  const driverActive =
    line.driverKey !== null &&
    line.driverRatePerUnit !== null &&
    line.driverValue !== null &&
    (line.driverKey !== 'headcount' || headcountPlanningEnabled);

  if (driverActive) {
    const annual = Money.parse(String(line.driverValue)).multiplyByRate(line.driverRatePerUnit!);
    // Spread evenly, giving the remainder to the final period so the periods
    // still sum exactly to the annual figure (INV-1).
    const per = annual.divideByRate(String(periodsInYear));
    if (period < periodsInYear) return per;
    const spread = Money.sum(Array.from({ length: periodsInYear - 1 }, () => per));
    return annual.subtract(spread);
  }

  const stored = line.periods[period];
  return stored ? Money.parse(stored) : Money.ZERO;
}

export interface LineTotals {
  lineId: string;
  local: Money;
  eur: Money;
  actualLocal: Money;
  actualEur: Money;
}

/**
 * The same fold as `computeLineTotals`, evaluated in the database.
 *
 * Added because `tools/loadtest.ts` measured the JavaScript version missing
 * NFR-001 at monthly × three-version scale: p95 557 ms against a 300 ms budget.
 * The measurement also said where the time was *not* — the underlying scan is
 * sub-millisecond with the 007 indexes — so the cost was `loadLines` building
 * two JSON arrays per line and the fold walking them, five times over for a
 * five-year trend.
 *
 * Two things make this equivalent rather than merely similar, and both are
 * asserted by `test/invariants.test.ts` comparing the two implementations over
 * the whole seeded dataset:
 *
 *   The driver case collapses. `effectivePeriodAmount` spreads a
 *   driver-computed annual figure across the periods and gives the remainder to
 *   the last one *precisely so the periods sum back to the annual figure*
 *   (INV-1). Summing that spread is therefore the annual figure, and SQL can
 *   write `driver_value * rate` directly instead of reproducing the spread.
 *
 *   The rounding matches. `Money.multiplyByRate` rounds half-away-from-zero at
 *   4 decimal places, and PostgreSQL's `round(numeric, 4)` does the same. The
 *   multiply happens before the round in both, so the rate's full precision is
 *   used exactly once.
 *
 * `computeLineTotals` is kept, not deleted: it is the readable definition, it
 * is what the property tests exercise, and it is the oracle this is checked
 * against. Deleting it would leave the SQL as the only statement of the rule.
 *
 * One query, not two. An earlier draft asked a second question to name the
 * currency with no rate; that cost a round trip on every report to describe a
 * failure that should not happen. The rate is now resolved in the CTE and a
 * null one is reported from the row itself.
 *
 * Several years at once, for the same reason. FR-061's trend is five years and
 * FR-062's variance is two; asking per year was five and two round trips for
 * one answer, and the trend was the slowest route in the application because of
 * it. The years cross-join the lines, so each year still resolves its own FX
 * rate and its own driver values — a year is not assumed to look like its
 * neighbour.
 */
function foldCte(
  entityIds: readonly string[],
  fiscalYears: readonly number[],
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
  budgetVersion: string,
): SqlFragment {
  return sql`
    with wanted as (
      select unnest(${[...fiscalYears]}::int[]) as fiscal_year
    ),
    -- The scope, as line ids and nothing else. The two aggregates below join
    -- through this rather than through "live" on purpose: "live" is years ×
    -- lines, and joining an aggregate to it on two columns made the planner
    -- estimate 37 groups where there were 588, pick a sort-based GroupAggregate
    -- and spend two thirds of the query sorting 7,000 rows it could have
    -- hashed. A single-column join to a single-column relation is a shape the
    -- planner gets right, and it took the statement from 13.7 ms to 5 ms.
    scoped as (
      select li.id from line_items li
      where li.entity_id = any(${[...entityIds]}::uuid[]) and li.deleted_at is null
    ),
    live as (
      select wanted.fiscal_year,
             li.id, li.entity_id, e.code as entity_code, li.category_id,
             c.name as category_name, c.position as category_position,
             li.name, li.currency, li.cost_type,
             li.asset_life_years, li.asset_life_status,
             li.driver_key, li.driver_rate_per_unit, d.value as driver_value,
             -- EUR is the reporting currency and is one, full stop -- not
             -- "one if no row says otherwise". loadFxTable sets it after
             -- reading the table for the same reason, and this has to match
             -- it: a stray EUR row would otherwise restate the whole
             -- consolidation here and nowhere else. Any other currency with no
             -- rate resolves to null and is refused below rather than silently
             -- converted at 1.0 -- the rule toEur enforces.
             case when li.currency = 'EUR' then 1 else fx.rate end as rate
      from wanted
      cross join line_items li
      join entities e on e.id = li.entity_id
      join categories c on c.id = li.category_id
      left join drivers d
        on d.entity_id = li.entity_id
       and d.driver_key = li.driver_key
       and d.fiscal_year = wanted.fiscal_year
      left join fx_rates fx
        on fx.currency = li.currency and fx.fiscal_year = wanted.fiscal_year
      where li.entity_id = any(${[...entityIds]}::uuid[]) and li.deleted_at is null
    ),
    planned as (
      select pa.line_id, pa.fiscal_year, sum(pa.amount) as total
      from period_amounts pa
      join scoped on scoped.id = pa.line_id
      where pa.fiscal_year = any(${[...fiscalYears]}::int[])
        and pa.budget_version = ${budgetVersion}
        -- The fold sums the periods the cycle has. Bounding here rather than
        -- summing whatever rows exist keeps this identical to the JavaScript
        -- definition when a granularity change has left longer-period rows
        -- behind.
        and pa.period <= ${periodsInYear}
      group by pa.line_id, pa.fiscal_year
    ),
    recorded as (
      select a.line_id, a.fiscal_year, sum(a.amount) as total
      from actuals a
      join scoped on scoped.id = a.line_id
      where a.fiscal_year = any(${[...fiscalYears]}::int[])
      group by a.line_id, a.fiscal_year
    ),
    folded as (
      select
        live.*,
        -- The driver case: the periods sum to the annual figure by
        -- construction, so the annual figure is the total.
        case
          when live.driver_key is not null
           and live.driver_rate_per_unit is not null
           and live.driver_value is not null
           and (live.driver_key <> 'headcount' or ${headcountPlanningEnabled})
          then round(live.driver_value * live.driver_rate_per_unit, 4)
          else coalesce(planned.total, 0)
        end as local,
        coalesce(recorded.total, 0) as actual_local
      from live
      left join planned
        on planned.line_id = live.id and planned.fiscal_year = live.fiscal_year
      left join recorded
        on recorded.line_id = live.id and recorded.fiscal_year = live.fiscal_year
    )
  `;
}

export async function loadLineTotals(
  db: Db,
  entityIds: readonly string[],
  fiscalYears: readonly number[],
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
  budgetVersion: string = WORKING_VERSION,
): Promise<LineTotalRow[]> {
  if (entityIds.length === 0 || fiscalYears.length === 0) return [];

  const rows = await db.query<{
    line_id: string;
    fiscal_year: number;
    entity_id: string;
    entity_code: string;
    category_id: string;
    category_name: string;
    category_position: number;
    name: string;
    currency: Currency;
    cost_type: string;
    asset_life_years: number | null;
    asset_life_status: string | null;
    local: string;
    eur: string | null;
    actual_local: string;
    actual_eur: string | null;
  }>(sql`
    ${foldCte(entityIds, fiscalYears, headcountPlanningEnabled, periodsInYear, budgetVersion)}
    select
      id as line_id, fiscal_year, entity_id, entity_code, category_id,
      category_name, category_position, name, currency, cost_type,
      asset_life_years, asset_life_status,
      local::text as local,
      round(local * rate, 4)::text as eur,
      actual_local::text as actual_local,
      round(actual_local * rate, 4)::text as actual_eur
    from folded
    order by fiscal_year, category_position, name
  `);

  const unpriced = rows.find((r) => r.eur === null);
  if (unpriced) {
    throw new Error(`no FX rate for ${unpriced.currency} in ${unpriced.fiscal_year}`);
  }

  return rows.map((r) => ({
    lineId: r.line_id,
    fiscalYear: r.fiscal_year,
    entityId: r.entity_id,
    entityCode: r.entity_code,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryPosition: r.category_position,
    name: r.name,
    currency: r.currency,
    costType: r.cost_type,
    assetLifeYears: r.asset_life_years,
    assetLifeStatus: r.asset_life_status,
    local: Money.parse(r.local),
    eur: Money.parse(r.eur!),
    actualLocal: Money.parse(r.actual_local),
    actualEur: Money.parse(r.actual_eur!),
  }));
}

/** What a grouped total is grouped by. */
export type TotalsGroup = 'year' | 'entity' | 'category';

export interface GroupedTotal {
  group: TotalsGroup;
  fiscalYear: number;
  /** Entity or category id; the fiscal year as a string for a `year` group. */
  key: string;
  /** Entity code or category name; empty for a `year` group. */
  label: string;
  /** Sort position within the group — category position, or 0. */
  position: number;
  plan: Money;
  actual: Money;
}

/**
 * The measures, identical in every branch below.
 *
 * Each line's EUR figure is rounded and *then* summed, which is the order
 * `rollUpTotals` folds in and the order INV-4 needs: a parent is the sum of the
 * figures its children display, not a re-rounding of an unrounded total.
 */
const GROUP_MEASURES = sql`
  coalesce(sum(round(local * rate, 4)), 0)::text as plan,
  coalesce(sum(round(actual_local * rate, 4)), 0)::text as actual,
  count(*) filter (where rate is null) as unpriced
`;

/**
 * One literal fragment per grouping rather than a column name chosen at
 * runtime. There are three groupings, they are known here, and writing them out
 * means no identifier reaches the statement from a variable at all — the
 * strongest form of the SEC-020 rule, rather than the allow-listed form.
 */
const GROUP_BRANCH: Record<TotalsGroup, SqlFragment> = {
  year: sql`
    select 'year'::text as grp, fiscal_year, fiscal_year::text as key,
           ''::text as label, 0 as position, ${GROUP_MEASURES}
    from folded group by fiscal_year
  `,
  entity: sql`
    select 'entity'::text as grp, fiscal_year, entity_id::text as key,
           entity_code as label, 0 as position, ${GROUP_MEASURES}
    from folded group by fiscal_year, entity_id, entity_code
  `,
  category: sql`
    select 'category'::text as grp, fiscal_year, category_id::text as key,
           category_name as label, category_position as position, ${GROUP_MEASURES}
    from folded group by fiscal_year, category_id, category_name, category_position
  `,
};

/**
 * The same fold, aggregated in the database instead of in JavaScript.
 *
 * This exists because of where the time actually went once the fold moved into
 * SQL. Under `tools/loadtest.ts` at twenty concurrent readers, the Node process
 * sat at one saturated core while the ten PostgreSQL backends between them used
 * 1.4 — the bottleneck was not the query, it was 2,940 rows a request crossing
 * into JavaScript to be turned into `Money` and then immediately summed away.
 * FR-060 renders 8 categories and 21 entities; it was parsing 588 rows to
 * produce 29 numbers.
 *
 * It shares `foldCte` with `loadLineTotals` rather than restating it, so there
 * is still exactly one definition of what a line's total is. And it is the same
 * arithmetic in the same order: each line's EUR figure is rounded first and the
 * rounded figures are summed, which is what `rollUpTotals` does and what INV-4
 * requires. `test/invariants.test.ts` asserts the two agree.
 *
 * Several groupings come back from one statement, unioned over a single
 * evaluation of the fold — FR-060 wants entities and categories together, and
 * asking twice would evaluate the fold twice.
 */
export async function loadGroupedTotals(
  db: Db,
  entityIds: readonly string[],
  fiscalYears: readonly number[],
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
  groups: readonly TotalsGroup[],
  budgetVersion: string = WORKING_VERSION,
): Promise<GroupedTotal[]> {
  if (entityIds.length === 0 || fiscalYears.length === 0 || groups.length === 0) return [];

  const branches = groups.map((group) => GROUP_BRANCH[group]);

  const rows = await db.query<{
    grp: TotalsGroup;
    fiscal_year: number;
    key: string;
    label: string;
    position: number;
    plan: string;
    actual: string;
    unpriced: string;
  }>(sql`
    ${foldCte(entityIds, fiscalYears, headcountPlanningEnabled, periodsInYear, budgetVersion)}
    ${join(branches, ' union all ')}
    order by 1, 2, 5, 4
  `);

  // Same refusal as the line-level fold: a missing rate is a data error, and
  // summing around it would produce a total that looks right and is not.
  if (rows.some((r) => Number(r.unpriced) > 0)) {
    throw new Error('no FX rate for one or more line currencies in the requested years');
  }

  return rows.map((r) => ({
    group: r.grp,
    fiscalYear: r.fiscal_year,
    key: r.key,
    label: r.label,
    position: r.position,
    plan: Money.parse(r.plan),
    actual: Money.parse(r.actual),
  }));
}

export interface VarianceRow {
  lineId: string;
  name: string;
  entityCode: string;
  categoryId: string;
  categoryName: string;
  current: Money;
  prior: Money;
  delta: Money;
}

/**
 * FR-062's line list: two years pivoted onto one row per line, largest absolute
 * movement first, and only as many rows as the view shows.
 *
 * The same reasoning as `loadGroupedTotals`, applied to a report that genuinely
 * needs line detail. It needs a hundred lines; it was folding, converting and
 * sorting eleven hundred to find them. Ordering and the limit belong on the
 * side that has all the rows.
 *
 * The tie-break is `(category_position, name)` rather than nothing, because
 * that is the order the line-level fold returns and the JavaScript sort was a
 * stable sort over it. Two lines that moved by the same amount therefore come
 * back in the same order they always did, rather than in whatever order the
 * plan happened to produce.
 */
export async function loadVarianceLines(
  db: Db,
  entityIds: readonly string[],
  priorYear: number,
  currentYear: number,
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
  limit: number,
  budgetVersion: string = WORKING_VERSION,
): Promise<VarianceRow[]> {
  if (entityIds.length === 0) return [];

  const rows = await db.query<{
    line_id: string;
    name: string;
    entity_code: string;
    category_id: string;
    category_name: string;
    current: string;
    prior: string;
    delta: string;
    unpriced: boolean;
  }>(sql`
    ${foldCte(
      entityIds, [priorYear, currentYear], headcountPlanningEnabled, periodsInYear, budgetVersion,
    )}
    , pivoted as (
      select id, name, entity_code, category_id, category_name, category_position,
             coalesce(sum(round(local * rate, 4))
               filter (where fiscal_year = ${currentYear}), 0) as current,
             coalesce(sum(round(local * rate, 4))
               filter (where fiscal_year = ${priorYear}), 0) as prior,
             bool_or(rate is null) as unpriced
      from folded
      group by id, name, entity_code, category_id, category_name, category_position
    )
    select line_id, name, entity_code, category_id, category_name,
           current::text as current, prior::text as prior, delta::text as delta, unpriced
    from (
      select id as line_id, name, entity_code, category_id, category_name,
             category_position, current, prior, current - prior as delta, unpriced
      from pivoted
    ) v
    order by abs(delta) desc, category_position, name
    limit ${limit}
  `);

  if (rows.some((r) => r.unpriced)) {
    throw new Error('no FX rate for one or more line currencies in the requested years');
  }

  return rows.map((r) => ({
    lineId: r.line_id,
    name: r.name,
    entityCode: r.entity_code,
    categoryId: r.category_id,
    categoryName: r.category_name,
    current: Money.parse(r.current),
    prior: Money.parse(r.prior),
    delta: Money.parse(r.delta),
  }));
}

/**
 * One year, for the reports that want one. A wrapper rather than a second
 * query, so there is still exactly one statement of the fold.
 */
export async function loadYearTotals(
  db: Db,
  entityIds: readonly string[],
  fiscalYear: number,
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
  budgetVersion: string = WORKING_VERSION,
): Promise<LineTotalRow[]> {
  return loadLineTotals(
    db, entityIds, [fiscalYear], headcountPlanningEnabled, periodsInYear, budgetVersion,
  );
}

/** Splits a multi-year result into one array per year, in the order asked for. */
export function byFiscalYear(
  rows: readonly LineTotalRow[],
): Map<number, LineTotalRow[]> {
  const out = new Map<number, LineTotalRow[]>();
  for (const row of rows) {
    const list = out.get(row.fiscalYear);
    if (list) list.push(row);
    else out.set(row.fiscalYear, [row]);
  }
  return out;
}

/** Totals plus the metadata every report groups, labels or filters by. */
export interface LineTotalRow extends LineTotals {
  fiscalYear: number;
  entityId: string;
  entityCode: string;
  categoryId: string;
  categoryName: string;
  categoryPosition: number;
  name: string;
  currency: Currency;
  costType: string;
  assetLifeYears: number | null;
  assetLifeStatus: string | null;
}

/**
 * INV-4 over the SQL-folded rows. Same contract as `rollUp`: the parent is the
 * sum of its children and nothing stores a parent figure independently.
 */
export function rollUpTotals<K extends string>(
  rows: readonly LineTotalRow[],
  keyOf: (row: LineTotalRow) => K,
): Map<K, { plan: Money; actual: Money }> {
  const out = new Map<K, { plan: Money; actual: Money }>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = out.get(key) ?? { plan: Money.ZERO, actual: Money.ZERO };
    out.set(key, {
      plan: current.plan.add(row.eur),
      actual: current.actual.add(row.actualEur),
    });
  }
  return out;
}

export function computeLineTotals(
  lines: readonly LineRow[],
  fx: FxTable,
  headcountPlanningEnabled: boolean,
  periodsInYear: number,
): LineTotals[] {
  return lines.map((line) => {
    const local = Money.sum(
      Array.from({ length: periodsInYear }, (_, i) =>
        effectivePeriodAmount(line, i + 1, headcountPlanningEnabled, periodsInYear),
      ),
    );
    const actualLocal = Money.sum(
      Object.values(line.actuals).map((a) => Money.parse(a)),
    );
    return {
      lineId: line.id,
      local,
      eur: toEur(local, line.currency, fx),
      actualLocal,
      actualEur: toEur(actualLocal, line.currency, fx),
    };
  });
}

/**
 * INV-4. Every rollup below is a fold over the same line totals — there is no
 * separate "category total" or "entity total" source of truth to drift.
 */
export function rollUp<K extends string>(
  lines: readonly LineRow[],
  totals: readonly LineTotals[],
  keyOf: (line: LineRow) => K,
): Map<K, { plan: Money; actual: Money }> {
  const byId = new Map(totals.map((t) => [t.lineId, t]));
  const out = new Map<K, { plan: Money; actual: Money }>();
  for (const line of lines) {
    const total = byId.get(line.id);
    if (!total) continue;
    const key = keyOf(line);
    const current = out.get(key) ?? { plan: Money.ZERO, actual: Money.ZERO };
    out.set(key, {
      plan: current.plan.add(total.eur),
      actual: current.actual.add(total.actualEur),
    });
  }
  return out;
}

export function groupTotal(totals: readonly LineTotals[]): { plan: Money; actual: Money } {
  return {
    plan: Money.sum(totals.map((t) => t.eur)),
    actual: Money.sum(totals.map((t) => t.actualEur)),
  };
}

/**
 * FR-041/FR-042. Only elapsed periods accept recorded spend, and a line
 * consuming faster than time elapsed is flagged.
 */
export function elapsedPeriods(fiscalYear: number, periodsInYear: number, now = new Date()): number {
  const currentYear = now.getUTCFullYear();
  if (currentYear > fiscalYear) return periodsInYear;
  if (currentYear < fiscalYear) return 0;
  const monthsElapsed = now.getUTCMonth() + 1;
  const monthsPerPeriod = 12 / periodsInYear;
  return Math.min(periodsInYear, Math.ceil(monthsElapsed / monthsPerPeriod));
}

export function isOverPace(
  plan: Money,
  actual: Money,
  elapsed: number,
  periodsInYear: number,
): boolean {
  if (plan.isZero()) return !actual.isZero();
  const expected = plan.multiplyByRate(String(elapsed)).divideByRate(String(periodsInYear));
  return actual.compare(expected) > 0;
}

/** FR-030: straight-line depreciation over the approved asset life. */
export function depreciationSchedule(
  capitalised: Money,
  assetLifeYears: number,
  startYear: number,
): { year: number; charge: Money }[] {
  if (assetLifeYears < 1) return [];
  const annual = capitalised.divideByRate(String(assetLifeYears));
  const schedule: { year: number; charge: Money }[] = [];
  let remaining = capitalised;
  for (let i = 0; i < assetLifeYears; i += 1) {
    // The final year absorbs the rounding remainder so the schedule sums back
    // to the capitalised amount exactly.
    const charge = i === assetLifeYears - 1 ? remaining : annual;
    schedule.push({ year: startYear + i, charge });
    remaining = remaining.subtract(charge);
  }
  return schedule;
}

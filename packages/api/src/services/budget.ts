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
import { sql } from '../db/pool.ts';

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

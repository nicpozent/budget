/**
 * Reporting (FR-042..FR-044, FR-060..FR-064).
 *
 * Every figure here is folded up from line level (INV-4). None of these
 * endpoints reads a stored parent total, because there isn't one — the earlier
 * prototype derived parents independently and the numbers stopped reconciling.
 *
 * Scope is applied before aggregation, never after. A manager's consolidation
 * is the sum of the lines they may see, computed from a query that only
 * returned those lines (SEC-011).
 *
 * The line-level fold itself runs in the database (`loadLineTotals`) rather
 * than in JavaScript. That is an NFR-001 decision with a measurement behind it,
 * not a preference — see the note on that function. What did *not* change is
 * where the aggregates come from: `rollUpTotals` is still a fold over line
 * rows, so INV-4 holds for the same reason it always did.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Money, schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requires } from '../http/guard.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { exportedRows } from '../observability/metrics.ts';
import {
  byFiscalYear,
  computeLineTotals,
  depreciationSchedule,
  elapsedPeriods,
  isOverPace,
  loadFxTable,
  loadGroupedTotals,
  loadLineTotals,
  loadLines,
  loadVarianceLines,
  loadYearTotals,
  rollUpTotals,
  toEur,
  type TotalsGroup,
} from '../services/budget.ts';
import { buildXlsx, num, text, type Sheet } from '../services/xlsx.ts';
import { loadCycle, periodsIn, visibleEntityIds } from './meta.ts';

export async function registerReportRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;

  /** FR-060 consolidation: group total, per-entity status, category split. */
  app.get('/api/reports/consolidation', { config: authenticatedRoute }, async (request) => {
    const ids = await visibleEntityIds(db, request, config.served);
    if (ids.length === 0) {
      return { total: '0.0000', entities: [], categories: [], countries: [] };
    }

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);

    // Four groupings from one evaluation of the fold. This report shows 21
    // entity rows, 8 category rows and 11 country rows; loading 588 line rows
    // to produce 40 numbers was the single largest source of per-request work
    // in the API.
    const grouped = await loadGroupedTotals(
      db, ids, [year], cycle.headcount_planning, periods,
      ['year', 'entity', 'country', 'category'],
    );
    const byEntity = new Map(
      grouped.filter((g) => g.group === 'entity').map((g) => [g.key, g]),
    );
    const categories = grouped.filter((g) => g.group === 'category');
    const whole = grouped.find((g) => g.group === 'year');

    const entityMeta = await db.query<{ id: string; code: string; name: string; state: string }>(sql`
      select id, code, name, state from entities where id = any(${ids}::uuid[]) order by code
    `);

    // Names for the countries that actually appeared, resolved after the fold
    // rather than joined inside it. `countries` is eleven rows, but the fold is
    // shared by every report and a join there is paid by all of them.
    const byCountry = grouped.filter((g) => g.group === 'country');
    const names = await db.query<{ code: string; name: string }>(sql`
      select code, name from countries where code = any(${byCountry.map((c) => c.key)}::text[])
    `);
    const countryNames = new Map(names.map((n) => [n.code, n.name]));

    return {
      total: (whole?.plan ?? Money.ZERO).toString(),
      actual: (whole?.actual ?? Money.ZERO).toString(),
      entities: entityMeta.map((e) => ({
        id: e.id,
        code: e.code,
        name: e.name,
        state: e.state,
        plan: (byEntity.get(e.id)?.plan ?? Money.ZERO).toString(),
        actual: (byEntity.get(e.id)?.actual ?? Money.ZERO).toString(),
      })),
      // Ordered by category position, and only categories with a visible line
      // appear — both fall out of the grouping rather than needing a filter.
      categories: categories.map((c) => ({
        id: c.key,
        name: c.label,
        plan: c.plan.toString(),
      })),
      // FR-060 read by jurisdiction. Same fold, same rounding order, so this
      // sums to the same group total the entity list does (INV-4) rather than
      // being a second opinion computed elsewhere.
      countries: byCountry.map((c) => ({
        code: c.key,
        name: countryNames.get(c.key) ?? c.key,
        plan: c.plan.toString(),
        actual: c.actual.toString(),
      })),
    };
  });

  /**
   * FR-061 five-year trend. Summed from the line level in every year, which is
   * what makes the breakdown reconcile when a category is exploded into its
   * lines.
   */
  app.get('/api/reports/trend', { config: authenticatedRoute }, async (request) => {
    const query = parse(
      z.object({
        entityId: schemas.uuid.optional(),
        mode: z.enum(['total', 'category', 'line']).default('total'),
      }),
      request.query,
    );

    const visible = await visibleEntityIds(db, request, config.served);
    const ids = query.entityId
      ? visible.filter((id) => id === query.entityId)
      : visible;
    if (ids.length === 0) return { years: [], series: [] };

    const years = [year - 4, year - 3, year - 2, year - 1, year];

    const series = new Map<string, { label: string; values: Record<number, string> }>();
    const totalsByYear: Record<number, string> = {};

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);

    // NFR-001. This was the slowest route in the application — `tools/loadtest.ts`
    // measured p95 at 557 ms against a 300 ms budget at monthly × three-version
    // scale — for three compounding reasons. `loadLines` built two JSON arrays
    // per line and `computeLineTotals` walked them; it did that five times, once
    // per year, in five round trips; and it did it at line level to draw a chart
    // of eight categories.
    //
    // All three are gone for the two aggregate modes: the fold runs in the
    // database, all five years come from one statement, and the grouping
    // happens there too. `line` mode still needs a row per line, because that
    // is what it draws.
    //
    // What is unchanged is that every figure is still the sum of the line
    // figures for that year, which is what makes an exploded category reconcile
    // with its parent (INV-4, NFR-004).
    if (query.mode === 'line') {
      const perYear = byFiscalYear(
        await loadLineTotals(db, ids, years, cycle.headcount_planning, periods),
      );
      for (const y of years) {
        const lineTotals = perYear.get(y) ?? [];
        totalsByYear[y] = Money.sum(lineTotals.map((t) => t.eur)).toString();
        for (const t of lineTotals) {
          const entry = series.get(t.lineId) ?? { label: t.name, values: {} };
          entry.values[y] = t.eur.toString();
          series.set(t.lineId, entry);
        }
      }
    } else {
      const groups: TotalsGroup[] = query.mode === 'category'
        ? ['year', 'category']
        : ['year'];
      const grouped = await loadGroupedTotals(
        db, ids, years, cycle.headcount_planning, periods, groups,
      );
      for (const g of grouped) {
        if (g.group === 'year') {
          totalsByYear[g.fiscalYear] = g.plan.toString();
          continue;
        }
        const entry = series.get(g.key) ?? { label: g.label, values: {} };
        entry.values[g.fiscalYear] = g.plan.toString();
        series.set(g.key, entry);
      }
      // A year with no visible line has no row to group, and the chart still
      // needs a point for it.
      for (const y of years) totalsByYear[y] ??= Money.ZERO.toString();
    }

    return {
      years,
      total: totalsByYear,
      series: [...series].map(([id, s]) => ({ id, label: s.label, values: s.values })),
    };
  });

  /** FR-062 variance: this year against last, largest movements first. */
  app.get('/api/reports/variance', { config: authenticatedRoute }, async (request) => {
    const query = parse(z.object({ entityId: schemas.uuid.optional() }), request.query);
    const visible = await visibleEntityIds(db, request, config.served);
    const ids = query.entityId ? visible.filter((id) => id === query.entityId) : visible;
    if (ids.length === 0) return { lines: [], categories: [] };

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);

    // Both years in one statement, twice: a variance is a comparison, so asking
    // per year was two round trips to answer one question. The line list is
    // ranked and cut in the database because the view shows a hundred rows and
    // there are eleven hundred to choose from.
    const TOP_LINES = 100;
    const lineVariances = await loadVarianceLines(
      db, ids, year - 1, year, cycle.headcount_planning, periods, TOP_LINES,
    );

    const categories = new Map<string, { name: string; current: Money; prior: Money }>();
    for (const g of await loadGroupedTotals(
      db, ids, [year - 1, year], cycle.headcount_planning, periods, ['category'],
    )) {
      const entry = categories.get(g.key)
        ?? { name: g.label, current: Money.ZERO, prior: Money.ZERO };
      if (g.fiscalYear === year) entry.current = g.plan;
      else entry.prior = g.plan;
      categories.set(g.key, entry);
    }

    return {
      lines: lineVariances.map((v) => ({
        id: v.lineId,
        name: v.name,
        categoryName: v.categoryName,
        entityCode: v.entityCode,
        current: v.current.toString(),
        prior: v.prior.toString(),
        delta: v.delta.toString(),
        // The README's convention: increases are the bad direction in a cost
        // tool, so the sign is carried through and the view colours it.
        direction: v.delta.compare(Money.ZERO) > 0
          ? 'increase'
          : v.delta.isZero() ? 'flat' : 'decrease',
      })),
      categories: [...categories].map(([id, c]) => ({
        id,
        name: c.name,
        current: c.current.toString(),
        prior: c.prior.toString(),
        delta: c.current.subtract(c.prior).toString(),
      })),
    };
  });

  /**
   * FR-043 / FR-044 consumption, with cascading filters.
   *
   * "Filtering never widens scope" is why the filter is applied to an already
   * scoped set rather than being turned into a query predicate on its own: the
   * worst a crafted filter can do is narrow.
   */
  app.get('/api/reports/consumption', { config: authenticatedRoute }, async (request) => {
    const query = parse(schemas.consumptionFilterSchema, request.query);
    const visible = await visibleEntityIds(db, request, config.served);
    const ids = query.entityId ? visible.filter((id) => id === query.entityId) : visible;
    if (ids.length === 0) {
      return { kpis: null, lines: [], categories: [], showFilters: false };
    }

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const elapsed = elapsedPeriods(year, periods);

    let totals = await loadYearTotals(db, ids, year, cycle.headcount_planning, periods);
    if (query.categoryId) totals = totals.filter((t) => t.categoryId === query.categoryId);

    const plan = Money.sum(totals.map((t) => t.eur));
    const actual = Money.sum(totals.map((t) => t.actualEur));
    const ytdPlan = plan.multiplyByRate(String(elapsed)).divideByRate(String(periods));

    return {
      // FR-044: the filter row is hidden when the caller has only one budget.
      showFilters: visible.length > 1,
      kpis: {
        plan: plan.toString(),
        actual: actual.toString(),
        ytdPlan: ytdPlan.toString(),
        variance: actual.subtract(ytdPlan).toString(),
        elapsedPeriods: elapsed,
        totalPeriods: periods,
      },
      lines: totals.map((t) => {
        const lineYtdPlan = t.eur.multiplyByRate(String(elapsed)).divideByRate(String(periods));
        return {
          id: t.lineId,
          name: t.name,
          entityCode: t.entityCode,
          categoryName: t.categoryName,
          currency: t.currency,
          plan: t.eur.toString(),
          actual: t.actualEur.toString(),
          ytdPlan: lineYtdPlan.toString(),
          variance: t.actualEur.subtract(lineYtdPlan).toString(),
          overPace: isOverPace(t.eur, t.actualEur, elapsed, periods),
        };
      }),
      categories: [...rollUpTotals(totals, (t) => t.categoryName)].map(([name, t]) => ({
        name,
        plan: t.plan.toString(),
        actual: t.actual.toString(),
      })),
    };
  });

  /** FR-030..FR-032 capex depreciation schedules. */
  app.get('/api/reports/capex', { config: authenticatedRoute }, async (request) => {
    const query = parse(z.object({ entityId: schemas.uuid.optional() }), request.query);
    const visible = await visibleEntityIds(db, request, config.served);
    const ids = query.entityId ? visible.filter((id) => id === query.entityId) : visible;
    if (ids.length === 0) return { lines: [], yearTotals: {} };

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const lines = (await loadYearTotals(db, ids, year, cycle.headcount_planning, periods))
      .filter((l) => l.costType === 'capex');

    const yearTotals: Record<number, Money> = {};
    const rows = lines.map((line) => {
      const capitalised = line.eur;
      const schedule = depreciationSchedule(capitalised, line.assetLifeYears ?? 0, year);
      for (const entry of schedule) {
        yearTotals[entry.year] = (yearTotals[entry.year] ?? Money.ZERO).add(entry.charge);
      }
      return {
        id: line.lineId,
        name: line.name,
        entityCode: line.entityCode,
        capitalised: capitalised.toString(),
        assetLifeYears: line.assetLifeYears,
        // FR-031: only the Finance Manager decides this, and until they do the
        // schedule is provisional.
        assetLifeStatus: line.assetLifeStatus ?? 'pending',
        schedule: schedule.map((s) => ({ year: s.year, charge: s.charge.toString() })),
      };
    });

    return {
      lines: rows,
      yearTotals: Object.fromEntries(
        Object.entries(yearTotals).map(([y, m]) => [y, m.toString()]),
      ),
    };
  });

  /** FR-063 FX rate history with EUR impact and volatility. */
  app.get('/api/reports/fx-history', { config: authenticatedRoute }, async () => {
    const rows = await db.query<{ currency: string; fiscal_year: number; rate: string }>(sql`
      select currency, fiscal_year, rate::text as rate
      from fx_rates where fiscal_year between ${year - 4} and ${year}
      order by currency, fiscal_year
    `);

    const byCurrency = new Map<string, { year: number; rate: string }[]>();
    for (const row of rows) {
      const list = byCurrency.get(row.currency) ?? [];
      list.push({ year: row.fiscal_year, rate: row.rate });
      byCurrency.set(row.currency, list);
    }

    return [...byCurrency].map(([currency, history]) => {
      const first = history[0];
      const last = history[history.length - 1];
      const drift =
        first && last && Money.parse(first.rate).compare(Money.ZERO) !== 0
          ? Money.parse(last.rate).subtract(Money.parse(first.rate)).toString()
          : '0.0000';
      return { currency, history, drift };
    });
  });

  /** FR-023 allocations: own vs charged vs total, read-only to the receiver. */
  app.get('/api/reports/allocations', { config: authenticatedRoute }, async (request) => {
    const ids = await visibleEntityIds(db, request, config.served);
    if (ids.length === 0) return { pools: [], entities: [] };

    const pools = await db.query<{ name: string; amount: string; currency: string; driver_key: string }>(sql`
      select name, amount::text as amount, currency, driver_key
      from allocation_pools where fiscal_year = ${year} order by name
    `);

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    // Still needed here, and only here: the pools carry their own currency and
    // are not line rows, so they are converted in JavaScript.
    const fx = await loadFxTable(db, year);
    // Per entity is all this report shows of the budget itself.
    const own = new Map(
      (await loadGroupedTotals(
        db, ids, [year], cycle.headcount_planning, periods, ['entity'],
      )).map((g) => [g.key, g]),
    );

    const drivers = await db.query<{ entity_id: string; driver_key: string; value: number }>(sql`
      select entity_id, driver_key, value from drivers
      where entity_id = any(${ids}::uuid[]) and fiscal_year = ${year}
    `);

    const entityMeta = await db.query<{ id: string; code: string }>(sql`
      select id, code from entities where id = any(${ids}::uuid[]) order by code
    `);

    return {
      pools: pools.map((p) => ({
        name: p.name,
        amount: p.amount,
        currency: p.currency,
        driverKey: p.driver_key,
      })),
      entities: entityMeta.map((e) => {
        let charged = Money.ZERO;
        for (const pool of pools) {
          const driverTotal = drivers
            .filter((d) => d.driver_key === pool.driver_key)
            .reduce((sum, d) => sum + d.value, 0);
          const mine = drivers.find(
            (d) => d.entity_id === e.id && d.driver_key === pool.driver_key,
          )?.value ?? 0;
          if (driverTotal > 0 && mine > 0) {
            const poolEur = toEur(Money.parse(pool.amount), pool.currency, fx);
            charged = charged.add(
              poolEur.multiplyByRate(String(mine)).divideByRate(String(driverTotal)),
            );
          }
        }
        const ownPlan = own.get(e.id)?.plan ?? Money.ZERO;
        return {
          id: e.id,
          code: e.code,
          own: ownPlan.toString(),
          charged: charged.toString(),
          total: ownPlan.add(charged).toString(),
          // INV-6: the receiving entity cannot change what it is charged.
          chargedReadOnly: true,
        };
      }),
    };
  });

  /**
   * FR-064 export. Rate limited (SEC-013) because a bulk export is both
   * expensive and the shape of a mass-exfiltration attempt — ZT-008 asks for an
   * alert on exactly this, so it is audited with the row count.
   */
  app.get(
    '/api/reports/export.xlsx',
    {
      config: {
        ...requires('budget.view.any'),
        rateLimit: { max: 5, timeWindow: '5 minutes' },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const ids = await visibleEntityIds(db, request, config.served);

      const cycle = await loadCycle(db, year);
      const periods = periodsIn(cycle.granularity);
      const fx = await loadFxTable(db, year);
      const lines = await loadLines(db, ids, year);
      const totals = new Map(
        computeLineTotals(lines, fx, cycle.headcount_planning, periods).map((t) => [t.lineId, t]),
      );

      const header = [
        text('Entity'), text('Category'), text('Line'), text('Vendor'),
        text('Cost centre'), text('Currency'), text('Plan (local)'), text('Plan (EUR)'),
      ];

      const sheet: Sheet = {
        name: `FY${year} consolidation`,
        rows: [
          header,
          ...lines.map((line) => {
            const t = totals.get(line.id)!;
            return [
              // Every one of these is attacker-influenced free text, and every
              // one goes through the formula-injection guard in xlsx.ts.
              text(line.entityCode),
              text(line.categoryName),
              text(line.name),
              text(line.vendor ?? ''),
              text(line.costCentreCode ?? ''),
              text(line.currency),
              num(t.local.toString()),
              num(t.eur.toString()),
            ];
          }),
        ],
      };

      const workbook = buildXlsx([sheet]);

      // ZT-008 alert 2. Export is deliberately low-frequency, so a spike in
      // rows leaving the system is the signal rather than the noise.
      exportedRows({ kind: 'xlsx' }, lines.length);

      await writeAudit(db, {
        actor: principal,
        action: 'report.export',
        targetType: 'report',
        targetId: null,
        detail: `Exported ${lines.length} lines across ${ids.length} entities to XLSX`,
        kind: 'governance',
        request,
      });

      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        // SEC-033: a fixed, non-reflected filename served as an attachment.
        .header('Content-Disposition', `attachment; filename="spendifre-fy${year}.xlsx"`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(workbook);
    },
  );
}

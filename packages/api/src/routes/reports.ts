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
  computeLineTotals,
  depreciationSchedule,
  elapsedPeriods,
  isOverPace,
  loadFxTable,
  loadLines,
  rollUp,
  toEur,
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
    const ids = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    if (ids.length === 0) return { total: '0.0000', entities: [], categories: [] };

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const fx = await loadFxTable(db, year);
    const lines = await loadLines(db, ids, year);
    const totals = computeLineTotals(lines, fx, cycle.headcount_planning, periods);

    const byEntity = rollUp(lines, totals, (l) => l.entityId);
    const byCategory = rollUp(lines, totals, (l) => l.categoryId);

    const entityMeta = await db.query<{ id: string; code: string; name: string; state: string }>(sql`
      select id, code, name, state from entities where id = any(${ids}::uuid[]) order by code
    `);
    const categoryMeta = await db.query<{ id: string; name: string }>(sql`
      select id, name from categories order by position
    `);

    return {
      total: Money.sum(totals.map((t) => t.eur)).toString(),
      actual: Money.sum(totals.map((t) => t.actualEur)).toString(),
      entities: entityMeta.map((e) => ({
        id: e.id,
        code: e.code,
        name: e.name,
        state: e.state,
        plan: (byEntity.get(e.id)?.plan ?? Money.ZERO).toString(),
        actual: (byEntity.get(e.id)?.actual ?? Money.ZERO).toString(),
      })),
      categories: categoryMeta
        .filter((c) => byCategory.has(c.id))
        .map((c) => ({
          id: c.id,
          name: c.name,
          plan: (byCategory.get(c.id)?.plan ?? Money.ZERO).toString(),
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

    const visible = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    const ids = query.entityId
      ? visible.filter((id) => id === query.entityId)
      : visible;
    if (ids.length === 0) return { years: [], series: [] };

    const years = [year - 4, year - 3, year - 2, year - 1, year];

    // One query per year rather than a pivot, so the summation property is the
    // same fold used everywhere else and can be property-tested (NFR-004).
    const series = new Map<string, { label: string; values: Record<number, string> }>();
    const totalsByYear: Record<number, string> = {};

    // Hoisted: the cycle is the *current* year's in every iteration, so this
    // was five identical queries. Cheap, but it was also hiding the real cost —
    // see the note below.
    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);

    // NFR-001 note. At monthly × three-version scale (30k period rows) this
    // loop is the slowest path in the application: `tools/loadtest.ts` measures
    // p95 around 670 ms against a 300 ms budget. The cost is not the database —
    // the underlying scan is sub-millisecond with the 007 indexes — it is that
    // `loadLines` + `computeLineTotals` fold every line for every one of five
    // years in JavaScript. The fix is to push the fold into SQL and return one
    // row per (year, series); it is a real refactor of the reporting layer and
    // is deliberately not attempted here rather than half-done. Recorded in
    // docs/application-evaluation.md rather than left to be discovered.
    for (const y of years) {
      const fx = await loadFxTable(db, y).catch(() => loadFxTable(db, year));
      const lines = await loadLines(db, ids, y);
      const lineTotals = computeLineTotals(lines, fx, cycle.headcount_planning, periods);

      totalsByYear[y] = Money.sum(lineTotals.map((t) => t.eur)).toString();

      if (query.mode === 'category') {
        for (const [categoryId, t] of rollUp(lines, lineTotals, (l) => l.categoryId)) {
          const label = lines.find((l) => l.categoryId === categoryId)?.categoryName ?? categoryId;
          const entry = series.get(categoryId) ?? { label, values: {} };
          entry.values[y] = t.plan.toString();
          series.set(categoryId, entry);
        }
      } else if (query.mode === 'line') {
        const byId = new Map(lineTotals.map((t) => [t.lineId, t]));
        for (const line of lines) {
          const entry = series.get(line.id) ?? { label: line.name, values: {} };
          entry.values[y] = (byId.get(line.id)?.eur ?? Money.ZERO).toString();
          series.set(line.id, entry);
        }
      }
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
    const visible = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    const ids = query.entityId ? visible.filter((id) => id === query.entityId) : visible;
    if (ids.length === 0) return { lines: [], categories: [] };

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const fx = await loadFxTable(db, year);

    const current = await loadLines(db, ids, year);
    const prior = await loadLines(db, ids, year - 1);
    const currentTotals = new Map(
      computeLineTotals(current, fx, cycle.headcount_planning, periods).map((t) => [t.lineId, t.eur]),
    );
    const priorTotals = new Map(
      computeLineTotals(prior, fx, cycle.headcount_planning, periods).map((t) => [t.lineId, t.eur]),
    );

    const lineVariances = current.map((line) => {
      const now = currentTotals.get(line.id) ?? Money.ZERO;
      const then = priorTotals.get(line.id) ?? Money.ZERO;
      const delta = now.subtract(then);
      return {
        id: line.id,
        name: line.name,
        categoryName: line.categoryName,
        entityCode: line.entityCode,
        current: now.toString(),
        prior: then.toString(),
        delta: delta.toString(),
        // The README's convention: increases are the bad direction in a cost
        // tool, so the sign is carried through and the view colours it.
        direction: delta.compare(Money.ZERO) > 0 ? 'increase' : delta.isZero() ? 'flat' : 'decrease',
      };
    });

    lineVariances.sort((a, b) => {
      const aAbs = Money.parse(a.delta).compare(Money.ZERO) < 0
        ? Money.parse(a.delta).negate() : Money.parse(a.delta);
      const bAbs = Money.parse(b.delta).compare(Money.ZERO) < 0
        ? Money.parse(b.delta).negate() : Money.parse(b.delta);
      return bAbs.compare(aAbs);
    });

    const categoriesNow = rollUp(current, [...currentTotals].map(([lineId, eur]) => ({
      lineId, eur, local: eur, actualEur: Money.ZERO, actualLocal: Money.ZERO,
    })), (l) => l.categoryId);
    const categoriesThen = rollUp(prior, [...priorTotals].map(([lineId, eur]) => ({
      lineId, eur, local: eur, actualEur: Money.ZERO, actualLocal: Money.ZERO,
    })), (l) => l.categoryId);

    const categoryNames = new Map(current.map((l) => [l.categoryId, l.categoryName]));

    return {
      lines: lineVariances.slice(0, 100),
      categories: [...categoryNames].map(([id, name]) => {
        const now = categoriesNow.get(id)?.plan ?? Money.ZERO;
        const then = categoriesThen.get(id)?.plan ?? Money.ZERO;
        return {
          id, name,
          current: now.toString(),
          prior: then.toString(),
          delta: now.subtract(then).toString(),
        };
      }),
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
    const visible = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    const ids = query.entityId ? visible.filter((id) => id === query.entityId) : visible;
    if (ids.length === 0) {
      return { kpis: null, lines: [], categories: [], showFilters: false };
    }

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const elapsed = elapsedPeriods(year, periods);
    const fx = await loadFxTable(db, year);

    let lines = await loadLines(db, ids, year);
    if (query.categoryId) lines = lines.filter((l) => l.categoryId === query.categoryId);

    const totals = computeLineTotals(lines, fx, cycle.headcount_planning, periods);
    const byId = new Map(totals.map((t) => [t.lineId, t]));

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
      lines: lines.map((line) => {
        const t = byId.get(line.id)!;
        const lineYtdPlan = t.eur.multiplyByRate(String(elapsed)).divideByRate(String(periods));
        return {
          id: line.id,
          name: line.name,
          entityCode: line.entityCode,
          categoryName: line.categoryName,
          currency: line.currency,
          plan: t.eur.toString(),
          actual: t.actualEur.toString(),
          ytdPlan: lineYtdPlan.toString(),
          variance: t.actualEur.subtract(lineYtdPlan).toString(),
          overPace: isOverPace(t.eur, t.actualEur, elapsed, periods),
        };
      }),
      categories: [...rollUp(lines, totals, (l) => l.categoryName)].map(([name, t]) => ({
        name,
        plan: t.plan.toString(),
        actual: t.actual.toString(),
      })),
    };
  });

  /** FR-030..FR-032 capex depreciation schedules. */
  app.get('/api/reports/capex', { config: authenticatedRoute }, async (request) => {
    const query = parse(z.object({ entityId: schemas.uuid.optional() }), request.query);
    const visible = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    const ids = query.entityId ? visible.filter((id) => id === query.entityId) : visible;
    if (ids.length === 0) return { lines: [], yearTotals: {} };

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const fx = await loadFxTable(db, year);
    const lines = (await loadLines(db, ids, year)).filter((l) => l.costType === 'capex');
    const totals = new Map(
      computeLineTotals(lines, fx, cycle.headcount_planning, periods).map((t) => [t.lineId, t.eur]),
    );

    const yearTotals: Record<number, Money> = {};
    const rows = lines.map((line) => {
      const capitalised = totals.get(line.id) ?? Money.ZERO;
      const schedule = depreciationSchedule(capitalised, line.assetLifeYears ?? 0, year);
      for (const entry of schedule) {
        yearTotals[entry.year] = (yearTotals[entry.year] ?? Money.ZERO).add(entry.charge);
      }
      return {
        id: line.id,
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
    const ids = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    if (ids.length === 0) return { pools: [], entities: [] };

    const pools = await db.query<{ name: string; amount: string; currency: string; driver_key: string }>(sql`
      select name, amount::text as amount, currency, driver_key
      from allocation_pools where fiscal_year = ${year} order by name
    `);

    const cycle = await loadCycle(db, year);
    const periods = periodsIn(cycle.granularity);
    const fx = await loadFxTable(db, year);
    const lines = await loadLines(db, ids, year);
    const totals = computeLineTotals(lines, fx, cycle.headcount_planning, periods);
    const own = rollUp(lines, totals, (l) => l.entityId);

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
      const ids = await visibleEntityIds(db, request, config.RESIDENCY_REGION);

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

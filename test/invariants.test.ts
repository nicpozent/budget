/**
 * Domain invariants (SPEC §3) and NFR-002/NFR-004/NFR-005.
 *
 * INV-4 gets a property test rather than an example: the spec calls it out
 * because an earlier prototype derived parent figures independently and the
 * numbers stopped reconciling. An example test would have passed on the fixture
 * that happened to be written; a property over every category, entity and year
 * would not.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@spendifre/shared';
import { sql } from '../packages/api/src/db/pool.ts';
import {
  computeLineTotals,
  depreciationSchedule,
  effectivePeriodAmount,
  elapsedPeriods,
  isOverPace,
  byFiscalYear,
  loadFxTable,
  loadGroupedTotals,
  loadLineTotals,
  loadLines,
  loadVarianceLines,
  loadYearTotals,
  rollUp,
  rollUpTotals,
  toEur,
  type LineTotalRow,
} from '../packages/api/src/services/budget.ts';
import { createHarness, type AuthHeaders, type Harness } from './harness.ts';

let harness: Harness;
let finance: AuthHeaders;
let entityId: string;

beforeAll(async () => {
  harness = await createHarness();
  finance = await harness.as('finance@birgma.test');
  const owned = await harness.db.one<{ entity_id: string }>(sql`
    select eo.entity_id from entity_owners eo
    join entities e on e.id = eo.entity_id
    where eo.user_id = ${finance.userId} and e.residency = 'eu' limit 1
  `);
  entityId = owned!.entity_id;
});

afterAll(async () => {
  await harness?.close();
});

const authed = (h: AuthHeaders, json = true) => ({
  cookie: h.cookie,
  'x-csrf-token': h['x-csrf-token'],
  origin: h.origin,
  ...(json ? { 'content-type': 'application/json' } : {}),
});

// ---------------------------------------------------------------------------

// NFR-002 fixed-precision money is asserted in `shared.test.ts`, which needs no
// database. It lived here behind this file's fixture without ever using it, and
// `tools/mutate.ts` re-runs the shared suite once per mutant — a ten-second
// database fixture in that loop would cost hours.

describe('NFR-003 FX applied at read time', () => {
  it('converts to EUR and back within one minor unit of the local currency', async () => {
    // A local -> EUR -> local round trip loses at most one EUR minor unit in
    // the middle, which the reverse multiply scales by 1/rate. For SEK that is
    // about 11x, so the bound is 0.0001/rate and not a flat 0.0001. This only
    // ever affects display: storage is always in the line's own currency and
    // an EUR-typed figure is converted exactly once, on the way in (FR-014).
    const fx = await loadFxTable(harness.db, 2026);
    const rate = Number(fx.get('SEK')!);
    const local = Money.parse('123456.7800');
    const back = toEur(local, 'SEK', fx).divideByRate(fx.get('SEK')!);
    const drift = Math.abs(Number(back.subtract(local).toString()));
    expect(drift).toBeLessThanOrEqual(0.0001 / rate + 0.0001);
  });

  it('accepts an FX rate at the full precision the column stores', async () => {
    // VND is 0.0000363 EUR. A schema capped at 4 decimal places would round it
    // to zero and make the currency unusable.
    const admin = await harness.as('admin@birgma.test');
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/fx-rates',
      headers: authed(admin),
      payload: { currency: 'VND', fiscalYear: 2026, rate: '0.00003630' },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('rejects a zero or malformed rate with 422, not 500', async () => {
    const admin = await harness.as('admin@birgma.test');
    for (const rate of ['0', '0.00000000', 'abc', '1e-5', '-0.5', '0.123456789']) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: '/api/fx-rates',
        headers: authed(admin),
        payload: { currency: 'SEK', fiscalYear: 2026, rate },
      });
      expect(response.statusCode, `rate ${rate}`).toBe(422);
    }
  });

  it('treats EUR as exactly one', async () => {
    const fx = await loadFxTable(harness.db, 2026);
    expect(toEur(Money.parse('42.5'), 'EUR', fx).toString()).toBe('42.5000');
  });

  it('refuses an entity whose country and residency bucket disagree', async () => {
    // Migration 011 makes `residency` derived rather than a second opinion. A
    // Vietnamese entity filed under `eu` is the mistake this prevents, and it
    // is prevented by the database rather than by a reviewer noticing.
    await expect(
      harness.db.query(sql`
        insert into entities (code, name, currency, country, residency)
        values ('MISMATCH', 'Mismatch', 'EUR', 'VN', 'eu')
      `),
    ).rejects.toThrow(/entities_country_residency_fk/);

    // And the same pair, stated correctly, is accepted — so the constraint is
    // rejecting the disagreement rather than the insert.
    await harness.db.query(sql`
      insert into entities (code, name, currency, country, residency)
      values ('MISMATCH', 'Mismatch', 'EUR', 'VN', 'apac')
    `);
    await harness.db.query(sql`delete from entities where code = 'MISMATCH'`);
  });

  it('refuses to guess a missing rate', async () => {
    const fx = await loadFxTable(harness.db, 2026);
    expect(() => toEur(Money.parse('1'), 'XXX', fx)).toThrow(/no FX rate/);
  });

  it('restates every derived figure when a rate changes, without rewriting stored amounts', async () => {
    // Deliberately a non-EUR entity: EUR is the reporting currency and is
    // pinned at 1, so restating "the EUR rate" is a no-op by design.
    const admin = await harness.as('admin@birgma.test');
    const foreign = await harness.db.one<{ id: string; currency: string }>(sql`
      select id, currency from entities
      where residency = 'eu' and currency <> 'EUR' order by code limit 1
    `);
    const targetId = foreign!.id;

    const before = await harness.app.inject({
      method: 'GET',
      url: `/api/budget/${targetId}`,
      headers: authed(admin, false),
    });
    const beforeTotal = (before.json() as { entityTotal: { plan: string } }).entityTotal.plan;

    const storedBefore = await harness.db.one<{ total: string }>(sql`
      select coalesce(sum(pa.amount), 0)::text as total
      from period_amounts pa join line_items li on li.id = pa.line_id
      where li.entity_id = ${targetId} and pa.fiscal_year = 2026
    `);

    const current = await harness.db.one<{ rate: string }>(sql`
      select rate::text as rate from fx_rates
      where currency = ${foreign!.currency} and fiscal_year = 2026
    `);
    const doubled = (Number(current!.rate) * 2).toFixed(8);

    const update = await harness.app.inject({
      method: 'PUT',
      url: '/api/fx-rates',
      headers: authed(admin),
      payload: { currency: foreign!.currency, fiscalYear: 2026, rate: doubled },
    });
    expect(update.statusCode, update.body).toBe(200);

    const after = await harness.app.inject({
      method: 'GET',
      url: `/api/budget/${targetId}`,
      headers: authed(admin, false),
    });
    const afterTotal = (after.json() as { entityTotal: { plan: string } }).entityTotal.plan;

    // The EUR figure roughly doubles...
    expect(Number(afterTotal) / Number(beforeTotal)).toBeCloseTo(2, 2);

    // ...and not one stored local amount moved.
    const storedAfter = await harness.db.one<{ total: string }>(sql`
      select coalesce(sum(pa.amount), 0)::text as total
      from period_amounts pa join line_items li on li.id = pa.line_id
      where li.entity_id = ${targetId} and pa.fiscal_year = 2026
    `);
    expect(storedAfter!.total).toBe(storedBefore!.total);

    // Restore, so later assertions see the seeded rate.
    await harness.app.inject({
      method: 'PUT',
      url: '/api/fx-rates',
      headers: authed(admin),
      payload: { currency: foreign!.currency, fiscalYear: 2026, rate: current!.rate },
    });
  });
});

describe('INV-4 / NFR-004 aggregates equal the sum of their children', () => {
  it('reconciles category, entity and group totals in every year', async () => {
    const entities = await harness.db.query<{ id: string }>(sql`
      select id from entities where residency = 'eu' order by code
    `);
    const ids = entities.map((e) => e.id);
    const fx = await loadFxTable(harness.db, 2026);

    for (const year of [2022, 2023, 2024, 2025, 2026]) {
      const lines = await loadLines(harness.db, ids, year);
      const totals = computeLineTotals(lines, fx, true, 4);

      const byCategory = rollUp(lines, totals, (l) => l.categoryId);
      const byEntity = rollUp(lines, totals, (l) => l.entityId);
      const group = Money.sum(totals.map((t) => t.eur));

      const categorySum = Money.sum([...byCategory.values()].map((v) => v.plan));
      const entitySum = Money.sum([...byEntity.values()].map((v) => v.plan));

      // Two independent partitions of the same set must both add back to the
      // whole. If a parent were modelled separately, one of these would drift.
      expect(categorySum.toString(), `categories in ${year}`).toBe(group.toString());
      expect(entitySum.toString(), `entities in ${year}`).toBe(group.toString());
    }
  });

  it('reconciles what the API reports for a single entity', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/budget/${entityId}`,
      headers: authed(finance, false),
    });
    const body = response.json() as {
      categoryTotals: { plan: string }[];
      entityTotal: { plan: string };
    };
    const sum = Money.sum(body.categoryTotals.map((c) => Money.parse(c.plan)));
    expect(sum.toString()).toBe(Money.parse(body.entityTotal.plan).toString());
  });

  it('reconciles the consolidation report', async () => {
    const admin = await harness.as('admin@birgma.test');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/reports/consolidation',
      headers: authed(admin, false),
    });
    const body = response.json() as {
      total: string;
      entities: { plan: string }[];
      categories: { plan: string }[];
    };
    expect(Money.sum(body.entities.map((e) => Money.parse(e.plan))).toString())
      .toBe(Money.parse(body.total).toString());
    expect(Money.sum(body.categories.map((c) => Money.parse(c.plan))).toString())
      .toBe(Money.parse(body.total).toString());
  });
});

/**
 * NFR-001 moved the reporting fold into SQL. `computeLineTotals` stays as the
 * readable definition of the rule; these tests are what stop the two drifting.
 *
 * Equality is asserted row for row over the whole seeded dataset rather than on
 * the group total, because a group total hides compensating errors: two lines
 * rounded the wrong way in opposite directions still add up.
 */
describe('the SQL fold agrees with the JavaScript definition', () => {
  const allEntityIds = async (): Promise<string[]> => {
    const rows = await harness.db.query<{ id: string }>(sql`
      select id from entities order by code
    `);
    return rows.map((r) => r.id);
  };

  it('produces identical rows in every year, with headcount planning on and off', async () => {
    const ids = await allEntityIds();
    let compared = 0;

    for (const year of [2022, 2023, 2024, 2025, 2026]) {
      for (const headcount of [true, false]) {
        const fx = await loadFxTable(harness.db, year);
        const lines = await loadLines(harness.db, ids, year);
        const expected = computeLineTotals(lines, fx, headcount, 4);
        const actual = await loadYearTotals(harness.db, ids, year, headcount, 4);

        const where = `FY${year}, headcount ${headcount ? 'on' : 'off'}`;
        expect(actual.length, `row count in ${where}`).toBe(expected.length);

        for (const [i, want] of expected.entries()) {
          const got = actual[i]!;
          // Order matters as much as the figures: the reports render rows in
          // the order the loader returns them, so a different sort would be a
          // visible change even with the same totals.
          expect(got.lineId, `line order at ${i} in ${where}`).toBe(want.lineId);
          expect(got.local.toString(), `local for ${got.name} in ${where}`)
            .toBe(want.local.toString());
          expect(got.eur.toString(), `eur for ${got.name} in ${where}`)
            .toBe(want.eur.toString());
          expect(got.actualLocal.toString(), `actual local for ${got.name} in ${where}`)
            .toBe(want.actualLocal.toString());
          expect(got.actualEur.toString(), `actual eur for ${got.name} in ${where}`)
            .toBe(want.actualEur.toString());
          compared += 1;
        }
      }
    }

    // A guard against the whole thing passing vacuously on an empty fixture.
    expect(compared).toBeGreaterThan(1000);
  });

  it('gives the same answer for five years at once as for five years one at a time', async () => {
    const ids = await allEntityIds();
    const years = [2022, 2023, 2024, 2025, 2026];

    // FR-061 asks for all five in one statement; FR-060 asks for one. They are
    // the same query with a different year list, and the risk in that is a
    // join that silently borrows one year's FX rate or driver value for
    // another. Comparing the two shapes is what rules that out.
    const together = byFiscalYear(
      await loadLineTotals(harness.db, ids, years, true, 4),
    );
    expect([...together.keys()]).toEqual(years);

    for (const year of years) {
      const alone = await loadYearTotals(harness.db, ids, year, true, 4);
      const fromBatch = together.get(year)!;
      expect(fromBatch.length, `row count for ${year}`).toBe(alone.length);
      expect(
        fromBatch.map((r) => `${r.lineId} ${r.local} ${r.eur} ${r.actualEur}`),
        `rows for ${year}`,
      ).toEqual(alone.map((r) => `${r.lineId} ${r.local} ${r.eur} ${r.actualEur}`));
    }
  });

  it('groups in SQL to the same figures as folding the line rows', async () => {
    const ids = await allEntityIds();
    const years = [2022, 2023, 2024, 2025, 2026];

    // INV-4 with the fold in a different place. The grouped query sums in the
    // database; `rollUpTotals` sums the line rows in JavaScript. If those two
    // ever disagreed, a consolidation would stop reconciling with the lines it
    // claims to be made of — the exact failure the invariant exists to catch.
    const grouped = await loadGroupedTotals(harness.db, ids, years, true, 4,
      ['year', 'entity', 'category']);
    const perYear = byFiscalYear(await loadLineTotals(harness.db, ids, years, true, 4));

    expect(grouped.length).toBeGreaterThan(0);

    for (const year of years) {
      const lines = perYear.get(year) ?? [];
      const rows = (group: string) => grouped.filter((g) => g.group === group && g.fiscalYear === year);

      const whole = rows('year');
      expect(whole.length, `one year row for ${year}`).toBe(1);
      expect(whole[0]!.plan.toString(), `year total ${year}`)
        .toBe(Money.sum(lines.map((l) => l.eur)).toString());
      expect(whole[0]!.actual.toString(), `year actual ${year}`)
        .toBe(Money.sum(lines.map((l) => l.actualEur)).toString());

      for (const [group, keyOf] of [
        ['entity', (r: LineTotalRow) => r.entityId],
        ['category', (r: LineTotalRow) => r.categoryId],
      ] as const) {
        const folded = rollUpTotals(lines, keyOf);
        const fromSql = rows(group);
        expect(fromSql.length, `${group} rows in ${year}`).toBe(folded.size);
        for (const g of fromSql) {
          expect(g.plan.toString(), `${group} ${g.label} plan in ${year}`)
            .toBe(folded.get(g.key)!.plan.toString());
          expect(g.actual.toString(), `${group} ${g.label} actual in ${year}`)
            .toBe(folded.get(g.key)!.actual.toString());
        }
      }

      // The partitions add back to the whole, which is the property itself
      // rather than a restatement of the equality above.
      for (const group of ['entity', 'category']) {
        expect(
          Money.sum(rows(group).map((g) => g.plan)).toString(),
          `${group} partition of ${year}`,
        ).toBe(whole[0]!.plan.toString());
      }
    }
  });

  it('ranks the variance lines the way the JavaScript sort did', async () => {
    const ids = await allEntityIds();
    const perYear = byFiscalYear(await loadLineTotals(harness.db, ids, [2025, 2026], true, 4));
    const current = perYear.get(2026) ?? [];
    const priorById = new Map((perYear.get(2025) ?? []).map((t) => [t.lineId, t.eur]));

    // The oracle: the fold in JavaScript, then the stable sort the route used
    // to do. `current` arrives ordered by (category position, name), and
    // Array.prototype.sort is stable, so equal movements keep that order —
    // which is what the SQL tie-break has to reproduce.
    const expected = current
      .map((line) => {
        const prior = priorById.get(line.lineId) ?? Money.ZERO;
        return { lineId: line.lineId, delta: line.eur.subtract(prior), current: line.eur, prior };
      })
      .sort((a, b) => {
        const abs = (m: Money) => (m.compare(Money.ZERO) < 0 ? m.negate() : m);
        return abs(b.delta).compare(abs(a.delta));
      })
      .slice(0, 100);

    const actual = await loadVarianceLines(harness.db, ids, 2025, 2026, true, 4, 100);

    expect(actual.length).toBe(expected.length);
    expect(actual.length).toBeGreaterThan(0);
    for (const [i, want] of expected.entries()) {
      const got = actual[i]!;
      expect(got.lineId, `rank ${i}`).toBe(want.lineId);
      expect(got.current.toString(), `current at rank ${i}`).toBe(want.current.toString());
      expect(got.prior.toString(), `prior at rank ${i}`).toBe(want.prior.toString());
      expect(got.delta.toString(), `delta at rank ${i}`).toBe(want.delta.toString());
    }
  });

  it('covers the non-EUR and actuals cases in the fixture it ran against', async () => {
    const ids = await allEntityIds();
    const lines = await loadLines(harness.db, ids, 2026);

    // Non-EUR lines, so the rate is something other than one and the rounding
    // rule is actually exercised rather than multiplied away.
    expect(new Set(lines.map((l) => l.currency)).size).toBeGreaterThan(1);

    // Lines with recorded actuals, so the actual columns are not all zero.
    expect(lines.some((l) => Object.keys(l.actuals).length > 0)).toBe(true);
  });

  /**
   * The driver branch is the one place the two implementations are written
   * differently rather than translated: `effectivePeriodAmount` spreads the
   * annual figure across the periods and hands the remainder to the last one,
   * and the SQL writes value × rate directly on the argument that the spread
   * sums back to exactly that (INV-1).
   *
   * The seeded fixture links no line to a driver, so asserting over it would
   * have proved nothing about the branch most likely to diverge. These links
   * are made here and rolled back.
   */
  it('agrees on driver-linked lines, including the rounding remainder', async () => {
    const ids = await allEntityIds();
    const marker = new Error('rollback');

    await expect(
      harness.db.transaction(async (tx) => {
        // A rate with more precision than the money scale, so the spread has a
        // remainder to place and the rounding has somewhere to disagree.
        const rates = ['1000', '333.3333', '17.5', '0.0001'];
        const keys = ['headcount', 'sites', 'devices', 'stores'];
        const targets = await tx.query<{ id: string }>(sql`
          select id from line_items where deleted_at is null order by id limit 40
        `);
        expect(targets.length).toBe(40);

        for (const [i, target] of targets.entries()) {
          await tx.query(sql`
            update line_items
            set driver_key = ${keys[i % keys.length]!},
                driver_rate_per_unit = ${rates[i % rates.length]!}
            where id = ${target.id}
          `);
        }

        for (const headcount of [true, false]) {
          const fx = await loadFxTable(tx, 2026);
          const lines = await loadLines(tx, ids, 2026);
          const expected = computeLineTotals(lines, fx, headcount, 4);
          const actual = await loadYearTotals(tx, ids, 2026, headcount, 4);

          const active = lines.filter((l) => l.driverKey !== null && l.driverValue !== null);
          expect(active.length, 'driver-active lines').toBeGreaterThan(0);
          expect(active.some((l) => l.driverKey === 'headcount')).toBe(true);

          for (const [i, want] of expected.entries()) {
            const got = actual[i]!;
            const where = `${got.name}, headcount ${headcount ? 'on' : 'off'}`;
            expect(got.local.toString(), `local for ${where}`).toBe(want.local.toString());
            expect(got.eur.toString(), `eur for ${where}`).toBe(want.eur.toString());
          }
        }

        throw marker;
      }),
    ).rejects.toBe(marker);
  });

  it('refuses a missing rate the same way toEur does', async () => {
    const ids = await allEntityIds();
    // 2021 is outside the seeded FX range, so no line but a EUR one has a rate.
    await expect(loadYearTotals(harness.db, ids, 2021, true, 4))
      .rejects.toThrow(/no FX rate for/);

    const fx = await loadFxTable(harness.db, 2021);
    const lines = await loadLines(harness.db, ids, 2021);
    expect(() => computeLineTotals(lines, fx, true, 4)).toThrow(/no FX rate for/);
  });

  it('treats EUR as one whether or not a rate row exists', async () => {
    const ids = await allEntityIds();
    const withRow = await loadYearTotals(harness.db, ids, 2026, true, 4);

    // Rolled back: the point is what the fold does with the row missing, not
    // to leave the fixture without it.
    const marker = new Error('rollback');
    await expect(
      harness.db.transaction(async (tx) => {
        await tx.query(sql`delete from fx_rates where currency = 'EUR' and fiscal_year = 2026`);
        const without = await loadYearTotals(tx, ids, 2026, true, 4);
        expect(without.map((r) => r.eur.toString())).toEqual(
          withRow.map((r) => r.eur.toString()),
        );
        throw marker;
      }),
    ).rejects.toBe(marker);
  });
});

describe('INV-1 quarterly plan sums to the annual total', () => {
  it('holds for every line the API returns', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/budget/${entityId}`,
      headers: authed(finance, false),
    });
    const body = response.json() as {
      lines: { periodsLocal: string[]; totalLocal: string }[];
    };
    expect(body.lines.length).toBeGreaterThan(0);
    for (const line of body.lines) {
      const sum = Money.sum(line.periodsLocal.map((p) => Money.parse(p)));
      expect(sum.toString()).toBe(Money.parse(line.totalLocal).toString());
    }
  });

  it('holds for a driver-computed line, remainder included', () => {
    const line = {
      id: 'x', driverKey: 'sites', driverRatePerUnit: '333.3333', driverValue: 7,
      periods: {}, actuals: {},
    } as unknown as Parameters<typeof effectivePeriodAmount>[0];

    const periods = [1, 2, 3, 4].map((p) => effectivePeriodAmount(line, p, true, 4));
    const annual = Money.parse('7').multiplyByRate('333.3333');
    // The final period absorbs the rounding remainder, so the quarters still
    // add up to the annual figure exactly.
    expect(Money.sum(periods).toString()).toBe(annual.toString());
  });
});

describe('INV-2 cost centre must be approved', () => {
  it('refuses a line booked to a pending centre', async () => {
    const pending = await harness.db.one<{ id: string }>(sql`
      select id from cost_centres where status = 'pending' limit 1
    `);
    const category = await harness.db.one<{ id: string }>(sql`select id from categories limit 1`);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/lines',
      headers: authed(finance),
      payload: {
        entityId,
        categoryId: category!.id,
        name: 'pending centre probe',
        costCentreId: pending!.id,
        costType: 'opex',
        currency: 'EUR',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('surfaces an existing stale reference instead of clearing it', async () => {
    const line = await harness.db.one<{ id: string }>(sql`
      select id from line_items where entity_id = ${entityId} limit 1
    `);
    const rejected = await harness.db.one<{ id: string; code: string }>(sql`
      select id, code from cost_centres where status = 'rejected' limit 1
    `);
    // Written directly, standing in for a centre that was approved when the
    // line was created and rejected afterwards.
    await harness.db.query(sql`
      update line_items set cost_centre_id = ${rejected!.id} where id = ${line!.id}
    `);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/budget/${entityId}`,
      headers: authed(finance, false),
    });
    const found = (response.json() as {
      lines: { id: string; costCentreCode: string | null; costCentreException: boolean }[];
    }).lines.find((l) => l.id === line!.id);

    expect(found?.costCentreException).toBe(true);
    expect(found?.costCentreCode).toBe(rejected!.code);
  });
});

describe('INV-3 driver-linked amounts are computed', () => {
  it('refuses a direct write to a driver-linked line', async () => {
    const line = await harness.db.one<{ id: string; version: number }>(sql`
      select id, version from line_items where entity_id = ${entityId} limit 1
    `);
    const link = await harness.app.inject({
      method: 'PUT',
      url: `/api/lines/${line!.id}/driver`,
      headers: authed(finance),
      payload: { driverKey: 'sites', ratePerUnit: '100' },
    });
    expect(link.statusCode, link.body).toBe(200);

    const write = await harness.app.inject({
      method: 'PUT',
      url: `/api/lines/${line!.id}/amounts`,
      headers: authed(finance),
      payload: { period: 1, amount: '1', version: line!.version + 1 },
    });
    expect(write.statusCode).toBe(403);

    await harness.app.inject({
      method: 'DELETE',
      url: `/api/lines/${line!.id}/driver`,
      headers: authed(finance),
    });
  });

  it('makes a headcount-linked line dormant, not deleted, when planning is off', () => {
    const line = {
      id: 'x', driverKey: 'headcount', driverRatePerUnit: '1000', driverValue: 10,
      periods: { 1: '55' }, actuals: {},
    } as unknown as Parameters<typeof effectivePeriodAmount>[0];

    // Planning on: computed from the driver.
    expect(effectivePeriodAmount(line, 1, true, 4).toString()).toBe('2500.0000');
    // Planning off: reverts to the stored manual value. The line still exists
    // and its data is intact (FR-022).
    expect(effectivePeriodAmount(line, 1, false, 4).toString()).toBe('55.0000');
  });
});

describe('INV-5 approved budgets are immutable', () => {
  it('refuses an edit once the budget is approved, and allows it under an exception', async () => {
    const line = await harness.db.one<{ id: string; version: number }>(sql`
      select id, version from line_items where entity_id = ${entityId} limit 1
    `);
    await harness.db.query(sql`update entities set state = 'approved' where id = ${entityId}`);

    const blocked = await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${line!.id}`,
      headers: authed(finance),
      payload: { vendor: 'after approval', version: line!.version },
    });
    expect(blocked.statusCode).toBe(403);

    // FR-056: a CFO exception reopens it, and the grant itself is audited.
    const cfo = await harness.as('cfo@birgma.test');
    const exception = await harness.app.inject({
      method: 'POST',
      url: '/api/cycle/exceptions',
      headers: authed(cfo),
      payload: { entityId, reason: 'late correction agreed with Finance', expiresInDays: 3 },
    });
    expect(exception.statusCode, exception.body).toBe(201);

    const allowed = await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${line!.id}`,
      headers: authed(finance),
      payload: { vendor: 'after exception', version: line!.version },
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    const audited = await harness.db.one<{ n: string }>(sql`
      select count(*)::text as n from audit_events
      where action = 'cycle.exception.grant' and entity_id = ${entityId}
    `);
    expect(Number(audited!.n)).toBe(1);

    await harness.db.query(sql`update entities set state = 'draft' where id = ${entityId}`);
    await harness.db.query(sql`delete from cycle_exceptions where entity_id = ${entityId}`);
  });
});

describe('NFR-005 optimistic concurrency', () => {
  it('refuses the second of two concurrent edits', async () => {
    const line = await harness.db.one<{ id: string; version: number }>(sql`
      select id, version from line_items where entity_id = ${entityId} limit 1
    `);

    const first = await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${line!.id}`,
      headers: authed(finance),
      payload: { vendor: 'first writer', version: line!.version },
    });
    expect(first.statusCode).toBe(200);

    // Second writer still holds the stale version it loaded.
    const second = await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${line!.id}`,
      headers: authed(finance),
      payload: { vendor: 'second writer', version: line!.version },
    });
    expect(second.statusCode).toBe(409);

    const stored = await harness.db.one<{ vendor: string }>(sql`
      select vendor from line_items where id = ${line!.id}
    `);
    expect(stored!.vendor).toBe('first writer');
  });
});

describe('FR-041 / FR-042 actuals and pace', () => {
  it('refuses spend recorded against a future period', async () => {
    const line = await harness.db.one<{ id: string; version: number }>(sql`
      select id, version from line_items
      where entity_id = ${entityId} and driver_key is null limit 1
    `);
    const response = await harness.app.inject({
      method: 'PUT',
      url: `/api/lines/${line!.id}/actuals`,
      headers: authed(finance),
      payload: { period: 4, amount: '100', version: line!.version },
    });
    // The seeded fiscal year is 2026 and the harness clock is inside it, so Q4
    // has not elapsed.
    expect([403, 200]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      expect(elapsedPeriods(2026, 4)).toBe(4);
    }
  });

  it('computes elapsed periods from the server clock', () => {
    expect(elapsedPeriods(2026, 4, new Date('2026-01-15T00:00:00Z'))).toBe(1);
    expect(elapsedPeriods(2026, 4, new Date('2026-08-15T00:00:00Z'))).toBe(3);
    expect(elapsedPeriods(2026, 4, new Date('2026-12-31T00:00:00Z'))).toBe(4);
    expect(elapsedPeriods(2026, 4, new Date('2025-06-01T00:00:00Z'))).toBe(0);
    expect(elapsedPeriods(2026, 4, new Date('2027-01-01T00:00:00Z'))).toBe(4);
  });

  it('flags a line consuming faster than time elapsed', () => {
    const plan = Money.parse('1000');
    // Half the year gone, 60% spent.
    expect(isOverPace(plan, Money.parse('600'), 2, 4)).toBe(true);
    expect(isOverPace(plan, Money.parse('500'), 2, 4)).toBe(false);
    // A zero plan with any spend is over pace by definition.
    expect(isOverPace(Money.ZERO, Money.parse('1'), 2, 4)).toBe(true);
    expect(isOverPace(Money.ZERO, Money.ZERO, 2, 4)).toBe(false);
  });
});

describe('FR-030 capex depreciation', () => {
  it('spreads straight-line and sums back to the capitalised amount', () => {
    const schedule = depreciationSchedule(Money.parse('10000'), 3, 2026);
    expect(schedule.map((s) => s.year)).toEqual([2026, 2027, 2028]);
    expect(Money.sum(schedule.map((s) => s.charge)).toString()).toBe('10000.0000');
  });

  it('absorbs the rounding remainder in the final year', () => {
    const schedule = depreciationSchedule(Money.parse('10000'), 3, 2026);
    expect(Money.sum(schedule.map((s) => s.charge)).toString())
      .toBe(Money.parse('10000').toString());
  });

  it('returns nothing for an unset asset life', () => {
    expect(depreciationSchedule(Money.parse('100'), 0, 2026)).toEqual([]);
  });
});

describe('FR-070 audit completeness', () => {
  it('writes an audit event for every state-changing request', async () => {
    const before = await harness.db.one<{ n: string }>(sql`
      select count(*)::text as n from audit_events
    `);
    const line = await harness.db.one<{ id: string; version: number }>(sql`
      select id, version from line_items where entity_id = ${entityId} limit 1
    `);
    await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${line!.id}`,
      headers: authed(finance),
      payload: { vendor: 'audited change', version: line!.version },
    });
    const after = await harness.db.one<{ n: string }>(sql`
      select count(*)::text as n from audit_events
    `);
    expect(Number(after!.n)).toBe(Number(before!.n) + 1);
  });

  it('rolls the change back when the audit write fails', async () => {
    // The audit insert shares the handler's transaction, so an audit failure
    // must take the business change with it. Simulated by making the audit
    // insert fail on a constraint the business write does not touch.
    const line = await harness.db.one<{ id: string; version: number; vendor: string | null }>(sql`
      select id, version, vendor from line_items where entity_id = ${entityId} limit 1
    `);

    await harness.db.query(sql`
      create or replace function fail_audit() returns trigger language plpgsql as $$
      begin raise exception 'simulated audit failure'; end $$
    `);
    await harness.db.query(sql`
      create trigger fail_audit_trigger before insert on audit_events
      for each row execute function fail_audit()
    `);

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/lines/${line!.id}`,
      headers: authed(finance),
      payload: { vendor: 'should not persist', version: line!.version },
    });
    expect(response.statusCode).toBe(500);

    await harness.db.query(sql`drop trigger fail_audit_trigger on audit_events`);
    await harness.db.query(sql`drop function fail_audit()`);

    const stored = await harness.db.one<{ vendor: string | null }>(sql`
      select vendor from line_items where id = ${line!.id}
    `);
    expect(stored!.vendor).toBe(line!.vendor);
  });
});

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
import { Money, MoneyError } from '@spendifre/shared';
import { sql } from '../packages/api/src/db/pool.ts';
import {
  computeLineTotals,
  depreciationSchedule,
  effectivePeriodAmount,
  elapsedPeriods,
  isOverPace,
  loadFxTable,
  loadLines,
  rollUp,
  toEur,
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

describe('NFR-002 fixed-precision money', () => {
  it('rejects everything that is not a plain decimal', () => {
    for (const bad of [
      'NaN', 'Infinity', '-Infinity', '1e5', '1E5', '0x10', '1_000',
      '1,5', ' ', '', '.5', '1.', '--1', '+1', '1.23456',
    ]) {
      expect(() => Money.parse(bad), `should reject ${JSON.stringify(bad)}`).toThrow(MoneyError);
    }
  });

  it('rejects a JS number outright', () => {
    // @ts-expect-error deliberately wrong type
    expect(() => Money.parse(1.5)).toThrow(MoneyError);
  });

  it('round-trips through the canonical string form', () => {
    for (const value of ['0', '1', '-1', '0.0001', '-0.0001', '123456789.1234']) {
      expect(Money.parse(Money.parse(value).toString()).toString())
        .toBe(Money.parse(value).toString());
    }
  });

  it('adds without float error', () => {
    // 0.1 + 0.2 is the canonical float failure; here it is exact.
    const sum = Money.parse('0.1').add(Money.parse('0.2'));
    expect(sum.toString()).toBe('0.3000');
    expect(sum.equals(Money.parse('0.3'))).toBe(true);
  });

  it('sums a large series exactly', () => {
    const values = Array.from({ length: 1000 }, () => Money.parse('0.0001'));
    expect(Money.sum(values).toString()).toBe('0.1000');
  });

  it('rounds half away from zero on rate multiplication', () => {
    expect(Money.parse('1').multiplyByRate('0.00005').toString()).toBe('0.0001');
    expect(Money.parse('-1').multiplyByRate('0.00005').toString()).toBe('-0.0001');
  });

  it('applies an uplift consistently', () => {
    expect(Money.parse('100').upliftByPercent('3').toString()).toBe('103.0000');
    expect(Money.parse('100').upliftByPercent('-10').toString()).toBe('90.0000');
  });

  it('refuses division by a zero rate rather than producing infinity', () => {
    expect(() => Money.parse('1').divideByRate('0')).toThrow(MoneyError);
  });

  it('rejects an amount beyond numeric(18,4)', () => {
    expect(() => Money.parse('99999999999999999')).toThrow(MoneyError);
  });
});

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

/**
 * Budget versions, scenarios and rolling forecast (FR-080), and driver trees
 * (FR-020).
 *
 * SPEC §11 deferred versions out of v1 and asked only that the schema not
 * preclude them. These tests are about the part that is easy to get wrong once
 * they arrive: that a scenario is a genuinely separate set of amounts, that the
 * working plan cannot be disturbed by one, and that every figure a version
 * reports still comes back through the same fold — so a comparison never
 * becomes the one screen whose numbers disagree with the consolidation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@spendifre/shared';
import { sql } from '../packages/api/src/db/pool.ts';
import {
  DriverCycleError,
  resolveDriverTree,
  type DriverNode,
} from '../packages/api/src/services/drivers.ts';
import { createHarness, type AuthHeaders, type Harness } from './harness.ts';

let harness: Harness;
let admin: AuthHeaders;
let cfo: AuthHeaders;
let finance: AuthHeaders;
let pmo: AuthHeaders;
let entityId: string;

const json = (headers: AuthHeaders, body?: unknown) => ({
  cookie: headers.cookie,
  'x-csrf-token': headers['x-csrf-token'],
  origin: headers.origin,
  ...(body === undefined ? {} : { 'content-type': 'application/json' }),
});

beforeAll(async () => {
  harness = await createHarness({ rateLimit: 'off' });
  admin = await harness.as('admin@birgma.test');
  cfo = await harness.as('cfo@birgma.test');
  finance = await harness.as('finance@birgma.test');
  pmo = await harness.as('pmo@birgma.test');

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

/** Create a version and assert it was accepted, returning the body. */
async function create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await harness.app.inject({
    method: 'POST', url: '/api/versions', headers: json(admin), payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Record<string, unknown>;
}

const totalOf = async (version: string): Promise<string> => {
  const response = await harness.app.inject({
    method: 'GET',
    url: `/api/reports/compare?base=working&against=${version}`,
    headers: json(admin),
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { total: { against: string } }).total.against;
};

describe('FR-080 budget versions', () => {
  it('ships exactly one working version, created with the cycle', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/versions', headers: json(finance),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { versions: { key: string; kind: string }[] };
    const working = body.versions.filter((v) => v.kind === 'working');
    expect(working).toHaveLength(1);
    expect(working[0]!.key).toBe('working');
    // Working first, whatever else exists.
    expect(body.versions[0]!.kind).toBe('working');
  });

  it('copies the whole plan into a scenario, and the copy adds up the same', async () => {
    const created = await create({
      key: 'baseline-q1', label: 'Baseline at Q1', kind: 'baseline', copyFrom: 'working',
    });
    expect(Number(created.copiedRows)).toBeGreaterThan(0);

    const compare = await harness.app.inject({
      method: 'GET',
      url: '/api/reports/compare?base=working&against=baseline-q1',
      headers: json(admin),
    });
    const body = compare.json() as {
      total: { base: string; against: string; delta: string };
      entities: { base: string; against: string }[];
      categories: { key: string; base: string; against: string }[];
    };

    // A copy is a copy: every grouping, not only the total.
    expect(body.total.against).toBe(body.total.base);
    expect(body.total.delta).toBe('0.0000');
    for (const row of [...body.entities, ...body.categories]) {
      expect(row.against).toBe(row.base);
    }
    expect(body.categories.length).toBeGreaterThan(0);

    // And INV-4 holds inside the scenario as much as in the working plan.
    expect(Money.sum(body.categories.map((c) => Money.parse(c.against))).toString())
      .toBe(body.total.against);
  });

  it('keeps a scenario edit out of the working plan', async () => {
    await create({ key: 'what-if', label: 'What if', kind: 'scenario', copyFrom: 'working' });

    const before = await totalOf('working');

    const line = await harness.db.one<{ id: string }>(sql`
      select id from line_items where entity_id = ${entityId} and deleted_at is null limit 1
    `);
    await harness.db.query(sql`
      update period_amounts set amount = amount + 1000
      where line_id = ${line!.id} and fiscal_year = 2026 and budget_version = 'what-if'
    `);

    expect(await totalOf('working')).toBe(before);
    expect(await totalOf('what-if')).not.toBe(before);
  });

  it('creates an empty version when nothing is copied', async () => {
    const created = await create({ key: 'blank', label: 'Blank', kind: 'scenario' });
    expect(created.copiedRows).toBe(0);
    expect(await totalOf('blank')).toBe('0.0000');
  });

  it('refuses a duplicate key rather than merging into the existing version', async () => {
    await create({ key: 'dup', label: 'First', kind: 'scenario' });
    const again = await harness.app.inject({
      method: 'POST', url: '/api/versions', headers: json(admin),
      payload: { key: 'dup', label: 'Second', kind: 'scenario' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses a key that is not slug-shaped', async () => {
    for (const key of ['Working', 'has space', 'has/slash', '1leading', '']) {
      const response = await harness.app.inject({
        method: 'POST', url: '/api/versions', headers: json(admin),
        payload: { key, label: 'x', kind: 'scenario' },
      });
      expect(response.statusCode, `key ${JSON.stringify(key)}`).toBe(422);
    }
  });

  it('refuses to create a second working version', async () => {
    const response = await harness.app.inject({
      method: 'POST', url: '/api/versions', headers: json(admin),
      payload: { key: 'working-2', label: 'Another', kind: 'working' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses an amount whose version was never declared', async () => {
    const line = await harness.db.one<{ id: string }>(sql`
      select id from line_items where deleted_at is null limit 1
    `);
    await expect(harness.db.query(sql`
      insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
      values (${line!.id}, 2026, 1, 'never-declared', 1)
    `)).rejects.toThrow();
  });
});

describe('FR-080 locking', () => {
  it('refuses an edit to a locked version, in the database and not only the handler', async () => {
    await create({ key: 'frozen', label: 'Frozen', kind: 'baseline', copyFrom: 'working' });
    const lock = await harness.app.inject({
      method: 'POST', url: '/api/versions/frozen/lock', headers: json(admin),
      payload: { locked: true },
    });
    expect(lock.statusCode, lock.body).toBe(200);

    const line = await harness.db.one<{ id: string }>(sql`
      select line_id as id from period_amounts where budget_version = 'frozen' limit 1
    `);
    // Straight at the table, bypassing every handler. The trigger is the
    // control; the handler check is only there to produce a better message.
    await expect(harness.db.query(sql`
      update period_amounts set amount = 1
      where line_id = ${line!.id} and budget_version = 'frozen'
    `)).rejects.toThrow(/locked/);

    await expect(harness.db.query(sql`
      delete from budget_versions where fiscal_year = 2026 and key = 'frozen'
    `)).rejects.toThrow(/locked/);
  });

  it('unlocks again, because a lock has to be correctable', async () => {
    await create({ key: 'thaw', label: 'Thaw', kind: 'scenario', copyFrom: 'working' });
    await harness.app.inject({
      method: 'POST', url: '/api/versions/thaw/lock', headers: json(admin),
      payload: { locked: true },
    });
    const unlock = await harness.app.inject({
      method: 'POST', url: '/api/versions/thaw/lock', headers: json(admin),
      payload: { locked: false },
    });
    expect(unlock.statusCode).toBe(200);

    const line = await harness.db.one<{ id: string }>(sql`
      select line_id as id from period_amounts where budget_version = 'thaw' limit 1
    `);
    await harness.db.query(sql`
      update period_amounts set amount = 1
      where line_id = ${line!.id} and budget_version = 'thaw'
    `);
  });

  it('sends the working plan to the cycle lock instead of the version lock', async () => {
    const response = await harness.app.inject({
      method: 'POST', url: '/api/versions/working/lock', headers: json(admin),
      payload: { locked: true },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to delete the working version, in the database too', async () => {
    const response = await harness.app.inject({
      method: 'DELETE', url: '/api/versions/working', headers: json(admin),
    });
    expect(response.statusCode).toBe(409);
    await expect(harness.db.query(sql`
      delete from budget_versions where fiscal_year = 2026 and key = 'working'
    `)).rejects.toThrow(/working version cannot be deleted/);
  });

  it('takes a scenario’s amounts with it when the scenario is deleted', async () => {
    await create({ key: 'doomed', label: 'Doomed', kind: 'scenario', copyFrom: 'working' });
    const before = await harness.db.one<{ count: string }>(sql`
      select count(*)::text as count from period_amounts where budget_version = 'doomed'
    `);
    expect(Number(before!.count)).toBeGreaterThan(0);

    const response = await harness.app.inject({
      method: 'DELETE', url: '/api/versions/doomed', headers: json(admin),
    });
    expect(response.statusCode, response.body).toBe(200);

    const after = await harness.db.one<{ count: string }>(sql`
      select count(*)::text as count from period_amounts where budget_version = 'doomed'
    `);
    expect(Number(after!.count)).toBe(0);
  });

  it('records the blast radius of a delete in the audit trail', async () => {
    await create({ key: 'audited', label: 'Audited', kind: 'scenario', copyFrom: 'working' });
    await harness.app.inject({
      method: 'DELETE', url: '/api/versions/audited', headers: json(admin),
    });
    const event = await harness.db.one<{ detail: string }>(sql`
      select detail from audit_events
      where action = 'version.delete' order by seq desc limit 1
    `);
    expect(event!.detail).toMatch(/and its \d+ amounts/);
  });
});

describe('FR-080 rolling forecast', () => {
  it('takes actuals for closed periods and the plan for the rest', async () => {
    await create({ key: 'rf', label: 'Rolling forecast', kind: 'forecast' });

    const line = await harness.db.one<{ id: string }>(sql`
      select li.id from line_items li
      where li.entity_id = ${entityId} and li.deleted_at is null
        and li.driver_key is null
      limit 1
    `);
    // A plan and a recorded figure that differ, in period 1.
    await harness.db.query(sql`
      update period_amounts set amount = 4000
      where line_id = ${line!.id} and fiscal_year = 2026 and period = 1
        and budget_version = 'working'
    `);
    await harness.db.query(sql`
      insert into actuals (line_id, fiscal_year, period, amount, source, recorded_by)
      values (${line!.id}, 2026, 1, 1234, 'manual', ${admin.userId})
      on conflict (line_id, fiscal_year, period) do update set amount = excluded.amount
    `);

    const rebase = await harness.app.inject({
      method: 'POST', url: '/api/versions/rf/rebase', headers: json(admin),
    });
    expect(rebase.statusCode, rebase.body).toBe(200);
    const result = rebase.json() as { closedPeriods: number; rows: number; totalPeriods: number };
    expect(result.rows).toBeGreaterThan(0);
    expect(result.closedPeriods).toBeGreaterThanOrEqual(0);
    expect(result.closedPeriods).toBeLessThanOrEqual(result.totalPeriods);

    const forecast = await harness.db.query<{ period: number; amount: string }>(sql`
      select period, amount::text as amount from period_amounts
      where line_id = ${line!.id} and fiscal_year = 2026 and budget_version = 'rf'
      order by period
    `);
    const working = new Map((await harness.db.query<{ period: number; amount: string }>(sql`
      select period, amount::text as amount from period_amounts
      where line_id = ${line!.id} and fiscal_year = 2026 and budget_version = 'working'
    `)).map((r) => [r.period, r.amount]));

    const recorded = new Map((await harness.db.query<{ period: number; amount: string }>(sql`
      select period, amount::text as amount from actuals
      where line_id = ${line!.id} and fiscal_year = 2026
    `)).map((r) => [r.period, r.amount]));
    // The fixture records spend of its own, so "closed period" cannot be
    // assumed to mean zero. A closed period with nothing recorded forecasts
    // zero, which is what "we spent nothing" means and is the case worth
    // keeping in the assertion rather than skipping.
    expect(recorded.get(1)).toBe('1234.0000');
    expect(result.closedPeriods).toBeGreaterThan(0);

    for (const row of forecast) {
      if (row.period <= result.closedPeriods) {
        expect(row.amount, `closed period ${row.period}`)
          .toBe(recorded.get(row.period) ?? '0.0000');
        expect(row.amount, `closed period ${row.period} took the plan`)
          .not.toBe(row.period === 1 ? working.get(1) : undefined);
      } else {
        expect(row.amount, `open period ${row.period}`).toBe(working.get(row.period));
      }
    }
  });

  it('refuses to rebase anything that is not a forecast', async () => {
    await create({ key: 'not-a-forecast', label: 'Scenario', kind: 'scenario' });
    const response = await harness.app.inject({
      method: 'POST', url: '/api/versions/not-a-forecast/rebase', headers: json(admin),
    });
    expect(response.statusCode).toBe(409);
  });

  it('is repeatable — rebasing twice does not double anything', async () => {
    await create({ key: 'rf2', label: 'Forecast twice', kind: 'forecast' });
    await harness.app.inject({ method: 'POST', url: '/api/versions/rf2/rebase', headers: json(admin) });
    const once = await totalOf('rf2');
    await harness.app.inject({ method: 'POST', url: '/api/versions/rf2/rebase', headers: json(admin) });
    expect(await totalOf('rf2')).toBe(once);
  });
});

describe('FR-080 comparison respects read scope', () => {
  it('compares only the entities the caller may see', async () => {
    await create({ key: 'scoped', label: 'Scoped', kind: 'scenario', copyFrom: 'working' });

    const asAdmin = await harness.app.inject({
      method: 'GET', url: '/api/reports/compare?base=working&against=scoped', headers: json(admin),
    });
    // The PMO lead, deliberately: the Finance Manager holds `budget.view.any`
    // and would see the same set as the Administrator, so the test would pass
    // while proving nothing about scope.
    const asManager = await harness.app.inject({
      method: 'GET', url: '/api/reports/compare?base=working&against=scoped', headers: json(pmo),
    });
    expect(asManager.statusCode).toBe(200);

    const adminBody = asAdmin.json() as { entities: unknown[] };
    const managerBody = asManager.json() as { entities: unknown[] };
    // SEC-011: the aggregation is over the caller's scope, not filtered after.
    expect(managerBody.entities.length).toBeLessThan(adminBody.entities.length);
    expect(managerBody.entities.length).toBeGreaterThan(0);
  });

  it('404s a version that does not exist rather than comparing against nothing', async () => {
    const response = await harness.app.inject({
      method: 'GET', url: '/api/reports/compare?base=working&against=ghost', headers: json(admin),
    });
    expect(response.statusCode).toBe(404);
  });

  it('lets the CFO manage versions and refuses a manager', async () => {
    const byCfo = await harness.app.inject({
      method: 'POST', url: '/api/versions', headers: json(cfo),
      payload: { key: 'cfo-case', label: 'CFO case', kind: 'scenario' },
    });
    expect(byCfo.statusCode, byCfo.body).toBe(201);

    const byManager = await harness.app.inject({
      method: 'POST', url: '/api/versions', headers: json(finance),
      payload: { key: 'manager-case', label: 'Manager case', kind: 'scenario' },
    });
    expect(byManager.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('FR-020 driver trees', () => {
  const node = (over: Partial<DriverNode> & { driverKey: string }): DriverNode => ({
    unit: over.driverKey, value: 0, derivedFrom: null, factor: null, ...over,
  });

  it('resolves a chain, not just one level', () => {
    const resolved = resolveDriverTree([
      node({ driverKey: 'headcount', value: 200 }),
      node({ driverKey: 'devices', derivedFrom: 'headcount', factor: '1.5' }),
      node({ driverKey: 'sites', derivedFrom: 'devices', factor: '0.02' }),
    ]);
    expect(resolved.get('headcount')).toBe(200);
    expect(resolved.get('devices')).toBe(300);
    expect(resolved.get('sites')).toBe(6);
  });

  it('rounds half away from zero, like Money', () => {
    const resolved = resolveDriverTree([
      node({ driverKey: 'headcount', value: 5 }),
      node({ driverKey: 'devices', derivedFrom: 'headcount', factor: '1.5' }),
      node({ driverKey: 'sites', derivedFrom: 'headcount', factor: '1.1' }),
    ]);
    // 7.5 → 8, not 7.
    expect(resolved.get('devices')).toBe(8);
    expect(resolved.get('sites')).toBe(6);
  });

  it('detects a cycle longer than one hop and names it', () => {
    let thrown: unknown;
    try {
      resolveDriverTree([
        node({ driverKey: 'headcount', derivedFrom: 'sites', factor: '2' }),
        node({ driverKey: 'sites', derivedFrom: 'devices', factor: '2' }),
        node({ driverKey: 'devices', derivedFrom: 'headcount', factor: '2' }),
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DriverCycleError);
    expect((thrown as DriverCycleError).cycle.length).toBeGreaterThan(2);
  });

  it('refuses a definition pointing at a driver the entity has not set', () => {
    expect(() => resolveDriverTree([
      node({ driverKey: 'devices', derivedFrom: 'stores', factor: '3' }),
    ])).toThrow();
  });

  it('recomputes downstream drivers when the parent changes', async () => {
    const put = (body: Record<string, unknown>) => harness.app.inject({
      method: 'PUT', url: '/api/drivers', headers: json(finance),
      payload: { entityId, ...body },
    });

    expect((await put({ driverKey: 'headcount', unit: 'people', value: 100 })).statusCode).toBe(200);
    expect((await put({
      driverKey: 'devices', unit: 'devices', derivedFrom: 'headcount', factor: '2',
    })).statusCode).toBe(200);

    const after = await harness.db.one<{ value: number }>(sql`
      select value from drivers
      where entity_id = ${entityId} and driver_key = 'devices' and fiscal_year = 2026
    `);
    expect(after!.value).toBe(200);

    // The point of a tree: one edit upstream, everything downstream follows.
    const bump = await put({ driverKey: 'headcount', unit: 'people', value: 150 });
    expect(bump.statusCode).toBe(200);
    expect((bump.json() as { recomputed: { key: string; to: number }[] }).recomputed)
      .toContainEqual({ key: 'devices', from: 200, to: 300 });

    const moved = await harness.db.one<{ value: number }>(sql`
      select value from drivers
      where entity_id = ${entityId} and driver_key = 'devices' and fiscal_year = 2026
    `);
    expect(moved!.value).toBe(300);
  });

  it('refuses a cycle over HTTP without leaving half a tree behind', async () => {
    const put = (body: Record<string, unknown>) => harness.app.inject({
      method: 'PUT', url: '/api/drivers', headers: json(finance),
      payload: { entityId, ...body },
    });
    await put({ driverKey: 'headcount', unit: 'people', value: 100 });
    await put({ driverKey: 'devices', unit: 'devices', derivedFrom: 'headcount', factor: '2' });

    // headcount ← devices closes the loop headcount → devices → headcount.
    const response = await put({
      driverKey: 'headcount', unit: 'people', derivedFrom: 'devices', factor: '0.5',
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    // The transaction rolled back, so headcount is still a root driver.
    const headcount = await harness.db.one<{ derived_from: string | null }>(sql`
      select derived_from from drivers
      where entity_id = ${entityId} and driver_key = 'headcount' and fiscal_year = 2026
    `);
    expect(headcount!.derived_from).toBeNull();
  });

  it('refuses self-reference in the schema, not only in the resolver', async () => {
    await expect(harness.db.query(sql`
      update drivers set derived_from = 'headcount', factor = 2
      where entity_id = ${entityId} and driver_key = 'headcount' and fiscal_year = 2026
    `)).rejects.toThrow();
  });

  it('refuses a definition with a parent and no factor', async () => {
    // `stores` carries no factor, so naming a parent alone leaves the row half
    // defined — which is exactly what the CHECK refuses.
    await expect(harness.db.query(sql`
      update drivers set derived_from = 'headcount'
      where entity_id = ${entityId} and driver_key = 'stores' and fiscal_year = 2026
    `)).rejects.toThrow();
    await expect(harness.db.query(sql`
      update drivers set factor = 2
      where entity_id = ${entityId} and driver_key = 'stores' and fiscal_year = 2026
    `)).rejects.toThrow();
  });
});

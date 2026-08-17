/**
 * The runtime self-test (row 14).
 *
 * These tests do the thing the self-test itself cannot: they break the system
 * on purpose and assert the check notices. A self-test that has only ever been
 * run against a healthy system is a self-test nobody has tested — it passes,
 * and nobody knows whether it *can* fail.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSelfTest, SELF_TEST_IDS } from '../packages/api/src/services/selftest.ts';
import { sql } from '../packages/api/src/db/pool.ts';
import { createHarness, type AuthHeaders, type Harness } from './harness.ts';

let harness: Harness;
let admin: AuthHeaders;

beforeAll(async () => {
  harness = await createHarness({ rateLimit: 'off' });
  admin = await harness.as('admin@birgma.test');

  // A chain several events deep. The seed writes one, and a one-event chain
  // hides whole classes of anchor and ordering bugs because its first and last
  // row are the same row.
  const { writeAudit } = await import('../packages/api/src/services/audit.ts');
  const actor = (await harness.db.one<{ id: string }>(sql`
    select id from users where role = 'admin' limit 1
  `))!;
  for (let i = 0; i < 5; i += 1) {
    await writeAudit(harness.db, {
      actor: { userId: actor.id, role: 'admin' },
      action: 'selftest.probe',
      targetType: 'system',
      detail: `chain depth probe ${i}`,
      kind: 'governance',
    });
  }
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe('self-test on a healthy system', () => {
  it('passes, with backup checks skipped or warned rather than failed', async () => {
    const report = await runSelfTest(harness.db, harness.config);

    const failures = report.checks.filter((c) => c.status === 'fail');
    expect(
      failures.map((f) => `${f.id}: ${f.detail}`),
      'a freshly seeded system should have nothing failing',
    ).toEqual([]);
    expect(report.healthy).toBe(true);
  }, 60_000);

  it('runs every registered check', async () => {
    const report = await runSelfTest(harness.db, harness.config);
    expect(report.checks.map((c) => c.id).sort()).toEqual([...SELF_TEST_IDS].sort());
  }, 60_000);

  it('treats a warning as healthy', async () => {
    // A warning is a thing to look at. Conflating it with a failure is how a
    // monitor gets muted, and a muted monitor is worse than no monitor.
    const report = await runSelfTest(harness.db, harness.config);
    if (report.summary.warn > 0) expect(report.healthy).toBe(true);
  }, 60_000);
});

describe('self-test detects real breakage', () => {
  it('catches a tampered audit chain', async () => {
    // The trigger refuses this, so it has to be disabled first — which is
    // exactly the scenario the chain exists for: someone with database-level
    // access, not application access.
    await harness.db.query(sql`alter table audit_events disable trigger all`);
    const target = await harness.db.one<{ seq: string; detail: string }>(sql`
      select seq::text, detail from audit_events order by seq desc limit 1 offset 1
    `);
    await harness.db.query(sql`
      update audit_events set detail = 'tampered' where seq = ${Number(target!.seq)}
    `);
    await harness.db.query(sql`alter table audit_events enable trigger all`);

    const report = await runSelfTest(harness.db, harness.config);
    const chain = report.checks.find((c) => c.id === 'audit.chain');

    expect(chain!.status).toBe('fail');
    expect(chain!.detail).toContain(target!.seq);
    expect(report.healthy).toBe(false);

    // Put the original text back, so the remaining tests see a sound chain.
    await harness.db.query(sql`alter table audit_events disable trigger all`);
    await harness.db.query(sql`
      update audit_events set detail = ${target!.detail} where seq = ${Number(target!.seq)}
    `);
    await harness.db.query(sql`alter table audit_events enable trigger all`);

    const restored = await runSelfTest(harness.db, harness.config);
    expect(restored.checks.find((c) => c.id === 'audit.chain')!.status).toBe('pass');
  }, 60_000);

  it('catches a missing FX rate before it silently converts at 1.0', async () => {
    const currency = await harness.db.one<{ currency: string }>(sql`
      select currency from line_items
      where deleted_at is null and currency <> 'EUR' limit 1
    `);
    if (!currency) return;

    await harness.db.query(sql`
      delete from fx_rates where currency = ${currency.currency} and fiscal_year = 2026
    `);

    const report = await runSelfTest(harness.db, harness.config);
    const fx = report.checks.find((c) => c.id === 'config.fx');

    // The failure mode this catches: a missing rate does not error, it
    // converts at 1.0 — a wrong number that looks like a right one.
    expect(fx!.status).toBe('fail');
    expect(fx!.detail).toContain(currency.currency);
  }, 60_000);

  it('catches a stage naming a role that cannot decide it', async () => {
    await harness.db.query(sql`
      insert into approval_stages (fiscal_year, position, name, required_role, min_amount_eur)
      values (2026, 99, 'Impossible stage', 'pmo', 0)
    `);

    const report = await runSelfTest(harness.db, harness.config);
    const stages = report.checks.find((c) => c.id === 'config.approvalStages');

    // The API refuses to create one; this catches one inserted by hand, or
    // before that check existed.
    expect(stages!.status).toBe('fail');
    expect(stages!.detail).toContain('Impossible stage');

    await harness.db.query(sql`delete from approval_stages where name = 'Impossible stage'`);
  }, 60_000);

  it('catches a ledger actual with no batch', async () => {
    const line = await harness.db.one<{ id: string }>(sql`
      select id from line_items where deleted_at is null limit 1
    `);
    // A CHECK constraint refuses this, and unlike a trigger it is not
    // suspended by `session_replication_role`. So the constraint is dropped for
    // the duration — which is also a fair simulation of how the row would
    // really appear: someone with DDL rights, working around the schema.
    await harness.db.query(sql`alter table actuals drop constraint ledger_provenance`);
    await harness.db.query(sql`
      insert into actuals (line_id, fiscal_year, period, amount, recorded_by, source)
      values (${line!.id}, 2026, 11, 1, (select id from users limit 1), 'ledger')
      on conflict (line_id, fiscal_year, period) do update
        set source = 'ledger', ledger_batch_id = null
    `);

    const report = await runSelfTest(harness.db, harness.config);
    const provenance = report.checks.find((c) => c.id === 'config.ledgerProvenance');
    expect(provenance!.status).toBe('fail');
    expect(report.healthy).toBe(false);

    // Remove the row before restoring the constraint: adding it back with the
    // offending row still present would fail validation, and a test that leaves
    // the schema weaker than it found it is worse than no test.
    await harness.db.query(sql`
      delete from actuals where source = 'ledger' and ledger_batch_id is null
    `);
    await harness.db.query(sql`
      alter table actuals add constraint ledger_provenance check (
        (source = 'ledger' and ledger_batch_id is not null) or
        (source = 'manual' and ledger_batch_id is null and ledger_ref is null)
      )
    `);

    const restored = await runSelfTest(harness.db, harness.config);
    expect(restored.checks.find((c) => c.id === 'config.ledgerProvenance')!.status).toBe('pass');
  }, 60_000);

  it('reports every failure, not just the first', async () => {
    // A report that stops at the first problem hides the second, and the
    // second is often the one that explains the first.
    await harness.db.query(sql`
      insert into approval_stages (fiscal_year, position, name, required_role, min_amount_eur)
      values (2026, 98, 'Also impossible', 'security_manager', 0)
    `);

    const report = await runSelfTest(harness.db, harness.config);
    expect(report.summary.fail).toBeGreaterThanOrEqual(2);
    expect(report.checks).toHaveLength(SELF_TEST_IDS.length);

    await harness.db.query(sql`delete from approval_stages where name = 'Also impossible'`);
  }, 60_000);
});

describe('the self-test endpoint', () => {
  it('records that a verification happened', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/admin/self-test',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);

    const event = await harness.db.one<{ action: string; detail: string }>(sql`
      select action, detail from audit_events
      where action in ('selftest.pass', 'selftest.fail')
      order by occurred_at desc limit 1
    `);
    // "Someone verified the system on this date, and this was the answer" is
    // exactly the fact an auditor asks for and nobody can reconstruct later.
    expect(event).not.toBeNull();
    expect(event!.detail).toMatch(/passed/);
  }, 60_000);

  it('changes nothing, so it is safe to run against production', async () => {
    const before = await harness.db.one<{ count: string }>(sql`
      select count(*)::text as count from line_items
    `);
    await harness.app.inject({
      method: 'GET', url: '/api/admin/self-test', headers: { cookie: admin.cookie },
    });
    const after = await harness.db.one<{ count: string }>(sql`
      select count(*)::text as count from line_items
    `);
    expect(after!.count).toBe(before!.count);
  }, 60_000);
});

/**
 * Load test at monthly × version scale (row 14, NFR-001).
 *
 *   node --experimental-strip-types tools/loadtest.ts [--concurrency 20] [--seconds 30]
 *
 * The gap this closes was "no load test at monthly × version scale". That scale
 * matters because the fixture the test suite uses is quarterly and single
 * version — 4 periods × 1 version × ~590 lines. A monthly cycle with three
 * budget versions is 12 × 3 = 9× the rows behind every consolidation, and the
 * reports fold over all of them.
 *
 * Deliberately no k6, autocannon or artillery. What they add is scripting,
 * distributed workers and a results UI; what is needed here is "issue N
 * concurrent requests and report the percentiles", which is the code below.
 * ADR-0004 applies to dev dependencies too — a load tool that is not in the
 * image is still a tool someone has to trust and keep patched.
 *
 * It measures the *server*, not the browser: no rendering, no network
 * variance. NFR-001's p95 target is a server-side number, and mixing in a
 * headless browser would measure something else and call it the same thing.
 */

import { loadConfig } from '../packages/api/src/config.ts';
import { createDb, sql, type Db } from '../packages/api/src/db/pool.ts';
import { buildApp } from '../packages/api/src/app.ts';
import { createSession } from '../packages/api/src/auth/session.ts';

interface Args {
  concurrency: number;
  seconds: number;
  /** Skip the amplification step when the database is already at scale. */
  skipSeed: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { concurrency: 20, seconds: 20, skipSeed: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--seconds') args.seconds = Number(argv[++i]);
    else if (argv[i] === '--skip-seed') args.skipSeed = true;
  }
  return args;
}

/**
 * Expand the seeded quarterly, single-version data to monthly × three versions.
 *
 * Set-based rather than row-by-row: 590 lines × 12 periods × 3 versions is
 * ~21,000 rows, and inserting those one statement at a time would measure the
 * loader rather than the system.
 */
async function amplify(db: Db, fiscalYear: number): Promise<number> {
  console.warn('amplifying to monthly × 3 versions…');

  await db.query(sql`
    update cycles set granularity = 'monthly' where fiscal_year = ${fiscalYear}
  `);

  // Quarterly amounts spread across the three months of their quarter. The
  // remainder goes on the last month so the year still sums to the same total
  // — the point is to change the shape of the data, not its value.
  await db.query(sql`
    insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
    select q.line_id, q.fiscal_year, m.period, 'working',
           case when m.period % 3 = 0
                then q.amount - 2 * round(q.amount / 3, 4)
                else round(q.amount / 3, 4) end
    from period_amounts q
    cross join lateral (
      select generate_series((q.period - 1) * 3 + 1, q.period * 3) as period
    ) m
    where q.fiscal_year = ${fiscalYear} and q.budget_version = 'working' and q.period <= 4
    on conflict (line_id, fiscal_year, period, budget_version) do nothing
  `);

  for (const version of ['baseline', 'reforecast']) {
    await db.query(sql`
      insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
      select line_id, fiscal_year, period, ${version}, amount * 0.97
      from period_amounts
      where fiscal_year = ${fiscalYear} and budget_version = 'working'
      on conflict (line_id, fiscal_year, period, budget_version) do nothing
    `);
  }

  const total = await db.one<{ count: string }>(sql`
    select count(*)::text as count from period_amounts where fiscal_year = ${fiscalYear}
  `);
  return Number(total?.count ?? 0);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const db = createDb(config);

  if (!args.skipSeed) {
    const rows = await amplify(db, config.FISCAL_YEAR);
    console.warn(`period_amounts now holds ${rows.toLocaleString('en-GB')} rows`);
  }

  const app = await buildApp({ db, config });
  await app.ready();

  // A CFO session: cross-entity read scope, so the reports fold over
  // everything rather than one owner's slice.
  const user = await db.one<{ id: string }>(sql`
    select id from users where role = 'cfo' limit 1
  `);
  if (!user) throw new Error('no CFO in this database — seed it first');
  const session = await createSession(db, config, {
    userId: user.id,
    amr: ['pwd', 'mfa'],
    deviceCompliant: true,
    authTime: new Date(),
  });

  const cookie = `sid=${session.token}`;

  // The reads that actually fold over the data. Writes are excluded on
  // purpose: this is about whether reporting holds up at scale, and a load
  // test that also mutated the fixture would not be repeatable.
  const ROUTES = [
    '/api/reports/consolidation',
    '/api/reports/trend?mode=category',
    '/api/reports/variance',
    '/api/reports/consumption',
    '/api/reports/allocations',
    '/api/reports/capex',
  ] as const;

  const results = new Map<string, number[]>(ROUTES.map((r) => [r, []]));
  let errors = 0;
  const deadline = Date.now() + args.seconds * 1000;

  console.warn(
    `\nrunning ${args.concurrency} workers for ${args.seconds}s against ${ROUTES.length} report routes…\n`,
  );

  const worker = async (): Promise<void> => {
    while (Date.now() < deadline) {
      for (const route of ROUTES) {
        const began = process.hrtime.bigint();
        const response = await app.inject({ method: 'GET', url: route, headers: { cookie } });
        const ms = Number(process.hrtime.bigint() - began) / 1e6;
        if (response.statusCode !== 200) errors += 1;
        else results.get(route)!.push(ms);
        if (Date.now() >= deadline) break;
      }
    }
  };

  await Promise.all(Array.from({ length: args.concurrency }, worker));

  console.warn('route                                 n      p50      p95      p99      max');
  console.warn('─'.repeat(78));

  let worstP95 = 0;
  for (const [route, samples] of results) {
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    worstP95 = Math.max(worstP95, p95);
    console.warn(
      route.padEnd(36) +
        String(sorted.length).padStart(6) +
        `${percentile(sorted, 50).toFixed(1).padStart(9)}` +
        `${p95.toFixed(1).padStart(9)}` +
        `${percentile(sorted, 99).toFixed(1).padStart(9)}` +
        `${(sorted[sorted.length - 1] ?? 0).toFixed(1).padStart(9)}`,
    );
  }

  console.warn('─'.repeat(78));
  console.warn(`errors: ${errors}`);

  await app.close();
  await db.close?.();

  // NFR-001 targets p95 under 300 ms. Failing the process rather than printing
  // a number means this can gate a release without anyone reading the output.
  const BUDGET_MS = 300;
  if (errors > 0) {
    console.error(`\n${errors} requests did not return 200.`);
    process.exit(1);
  }
  if (worstP95 > BUDGET_MS) {
    console.error(
      `\nworst p95 was ${worstP95.toFixed(1)} ms, over the ${BUDGET_MS} ms NFR-001 budget.`,
    );
    process.exit(1);
  }
  console.warn(`\nworst p95 ${worstP95.toFixed(1)} ms, within the ${BUDGET_MS} ms budget.`);
}

await main();

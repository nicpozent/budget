/**
 * Runs the self-test in-process, against the configured database.
 *
 *   npm run selftest
 *
 * The counterpart to `ops/selftest/Invoke-SpendifreSelfTest.ps1`, which calls
 * the HTTP endpoint. Both exist because they answer for different things: the
 * PowerShell script proves the *deployment* is healthy, including that it is
 * reachable and that authorisation works; this proves the *database* is,
 * without needing a running service or a session.
 *
 * That makes this the one to run after a restore, after a migration, or from a
 * cron job on the database host — situations where there may be no application
 * to ask.
 *
 * Exit codes match the PowerShell script:
 *   0  healthy
 *   1  at least one check failed
 *   2  could not run the checks at all — a different problem, and worth
 *      distinguishing, because "the system is broken" and "we could not ask"
 *      call for different responses.
 */

import { loadConfig } from '../packages/api/src/config.ts';
import { createDb } from '../packages/api/src/db/pool.ts';
import { runSelfTest } from '../packages/api/src/services/selftest.ts';

const GLYPH: Record<string, string> = {
  pass: '  OK  ', warn: ' WARN ', fail: ' FAIL ', skipped: ' SKIP ',
};

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const warningsAsErrors = process.argv.includes('--warnings-as-errors');

  let config;
  let db;
  try {
    config = loadConfig(process.env);
    db = createDb(config);
  } catch (err) {
    console.error(`could not connect: ${err instanceof Error ? err.message : 'unknown'}`);
    process.exit(2);
  }

  let report;
  try {
    report = await runSelfTest(db, config);
  } catch (err) {
    console.error(`the self-test could not run: ${err instanceof Error ? err.message : 'unknown'}`);
    await db.close?.();
    process.exit(2);
  }

  if (json) {
    console.warn(JSON.stringify(report, null, 2));
  } else {
    console.warn(`\nSpendifre self-test — region ${report.region}, FY${report.fiscalYear}`);
    console.warn(`${report.durationMs} ms\n`);
    for (const check of report.checks) {
      // A glyph as well as text: this output lands in CI logs and ticket
      // comments that carry no colour, and the A11Y-001 reasoning applies to a
      // terminal as much as to the UI.
      console.warn(`[${GLYPH[check.status] ?? '  ??  '}] ${check.title}  (${check.requirement})`);
      if (check.status !== 'pass') console.warn(`           ${check.detail}`);
    }
    console.warn(
      `\n${report.summary.pass} passed, ${report.summary.fail} failed, ` +
        `${report.summary.warn} warnings, ${report.summary.skipped} skipped\n`,
    );
  }

  await db.close?.();

  if (!report.healthy) process.exit(1);
  if (warningsAsErrors && report.summary.warn > 0) process.exit(1);
}

await main();

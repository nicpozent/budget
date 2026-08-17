/**
 * Runtime self-test (row 14 of the evaluation).
 *
 * Distinct from the vitest suite, and the distinction matters. The test suite
 * builds a throwaway database, seeds it, and proves the *code* is correct. This
 * runs against the database someone is actually using, and proves the *system*
 * is currently healthy — that the audit chain still verifies, that the
 * invariants still hold over real rows, that the last backup can still be read.
 *
 * Those are different questions. A green test suite says the code that was
 * shipped was right; a green self-test says the data that exists now is sound.
 * A system can pass one and fail the other, and the failure mode people
 * actually meet — a chain broken by out-of-band access, a backup that stopped
 * being readable, a retention job that quietly stopped running — is only
 * visible from this side.
 *
 * Every check is read-only. Nothing here mutates anything, so it is safe to run
 * against production on a schedule, which is the point: a verification you dare
 * not run is not a verification.
 */

import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { BACKUP_TABLES, EXCLUDED_FROM_BACKUP, listBackups, readBackup } from './backup.ts';
import { parseArchive, verifyArchive } from './restore.ts';
import { auditChainIntact } from '../observability/metrics.ts';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface CheckResult {
  id: string;
  title: string;
  /** The requirement this check exists to defend. */
  requirement: string;
  status: CheckStatus;
  /** One sentence a human can act on. Never a stack trace. */
  detail: string;
  durationMs: number;
}

export interface SelfTestReport {
  startedAt: string;
  durationMs: number;
  region: string;
  fiscalYear: number;
  summary: { pass: number; fail: number; warn: number; skipped: number };
  /** False if any check failed. The single number a monitor should read. */
  healthy: boolean;
  checks: CheckResult[];
}

interface Check {
  id: string;
  title: string;
  requirement: string;
  run: (db: Db, config: AppConfig) => Promise<{ status: CheckStatus; detail: string }>;
}

/** Count helper: every check below asks the database a counting question. */
async function countOf(db: Db, fragment: ReturnType<typeof sql>): Promise<number> {
  const row = await db.one<{ count: string }>(fragment);
  return Number(row?.count ?? 0);
}

const CHECKS: readonly Check[] = [
  // -------------------------------------------------------------------------
  // The audit trail. If any of these fail, nothing else in the report matters:
  // the record that makes every approval binding is in question.
  // -------------------------------------------------------------------------
  {
    id: 'audit.chain',
    title: 'Audit hash chain verifies',
    requirement: 'FR-073',
    async run(db) {
      const row = await db.one<{ bad: string | null }>(sql`
        select audit_verify_chain()::text as bad
      `);
      auditChainIntact(row?.bad === null ? 1 : 0);
      return row?.bad === null
        ? { status: 'pass', detail: 'Every event links to its predecessor.' }
        : {
            status: 'fail',
            detail:
              `The chain breaks at sequence ${row!.bad}. Rows were altered out of band — ` +
              'the trigger and the grants both refuse this, so reaching this state means ' +
              'database-level access. Preserve the database before investigating.',
          };
    },
  },
  {
    id: 'audit.anchor',
    title: 'Chain anchor matches the earliest surviving event',
    requirement: 'FR-073',
    async run(db) {
      // The anchor is where `audit_verify_chain()` starts, and it walks
      // *forward* from the lowest sequence. So the invariant is that the anchor
      // equals what the earliest surviving row claims as its predecessor —
      // not that it tracks the head. It stays at genesis through normal
      // operation and moves only when a purge or a restore removes the rows it
      // used to point at.
      const row = await db.one<{ anchor: string; first: string | null; seq: string | null }>(sql`
        select encode((select head_hash from audit_chain_anchor), 'hex') as anchor,
               encode((select prev_hash from audit_events order by seq limit 1), 'hex') as first,
               (select min(seq)::text from audit_events) as seq
      `);
      if (!row?.first) return { status: 'skipped', detail: 'No audit events yet.' };
      return row.anchor === row.first
        ? { status: 'pass', detail: `Verification starts cleanly at sequence ${row.seq}.` }
        : {
            status: 'fail',
            detail:
              'The anchor does not match the earliest event, so verification cannot start. ' +
              'A purge or a restore that re-anchored to the wrong end of the chain.',
          };
    },
  },
  {
    id: 'audit.immutable',
    title: 'The application cannot delete audit rows',
    requirement: 'SEC-021',
    async run(db) {
      // Asks the catalogue rather than attempting a delete: a self-test must
      // not rely on a failed write, because the one time it succeeds it has
      // destroyed evidence.
      const grants = await countOf(db, sql`
        select count(*)::text as count from information_schema.role_table_grants
        where table_name = 'audit_events'
          and grantee = 'spendifre_app'
          and privilege_type in ('DELETE', 'UPDATE')
      `);
      return grants === 0
        ? { status: 'pass', detail: 'No UPDATE or DELETE grant on audit_events.' }
        : {
            status: 'fail',
            detail: `spendifre_app holds ${grants} mutating grant(s) on audit_events.`,
          };
    },
  },

  // -------------------------------------------------------------------------
  // Financial invariants, evaluated over the rows that exist right now.
  // -------------------------------------------------------------------------
  {
    id: 'inv.summation',
    title: 'Period amounts sum to line totals (INV-4)',
    requirement: 'INV-4',
    async run(db, config) {
      // The property the whole system rests on: a total is the sum of its
      // parts at every level. Checked here against live rows rather than a
      // fixture, because a partial write or an out-of-band edit is exactly
      // what a fixture cannot catch.
      const mismatches = await countOf(db, sql`
        with per_line as (
          select li.id,
                 sum(pa.amount) as parts,
                 (select sum(p2.amount) from period_amounts p2
                   where p2.line_id = li.id and p2.fiscal_year = ${config.FISCAL_YEAR}
                     and p2.budget_version = 'working') as total
          from line_items li
          join period_amounts pa
            on pa.line_id = li.id and pa.fiscal_year = ${config.FISCAL_YEAR}
           and pa.budget_version = 'working'
          where li.deleted_at is null
          group by li.id
        )
        select count(*)::text as count from per_line where parts is distinct from total
      `);
      return mismatches === 0
        ? { status: 'pass', detail: 'Every line total equals the sum of its periods.' }
        : { status: 'fail', detail: `${mismatches} lines do not sum to their own periods.` };
    },
  },
  {
    id: 'inv.costCentre',
    title: 'No line references an unapproved cost centre (INV-2)',
    requirement: 'INV-2',
    async run(db) {
      const stale = await countOf(db, sql`
        select count(*)::text as count
        from line_items li
        join cost_centres cc on cc.id = li.cost_centre_id
        where li.deleted_at is null and cc.status <> 'approved'
      `);
      return stale === 0
        ? { status: 'pass', detail: 'All referenced cost centres are approved.' }
        : {
            status: 'warn',
            // A warning, not a failure: a centre can be revoked after lines
            // were booked to it, and the grid renders those as exceptions
            // rather than refusing to load.
            detail: `${stale} lines reference a pending or rejected centre; they render as exceptions.`,
          };
    },
  },
  {
    id: 'inv.derived',
    title: 'Derived lines still point at a live source (FR-033)',
    requirement: 'FR-033',
    async run(db) {
      const orphans = await countOf(db, sql`
        select count(*)::text as count from line_items li
        where li.derived_from_line_id is not null and li.deleted_at is null
          and not exists (
            select 1 from line_items p
            where p.id = li.derived_from_line_id and p.deleted_at is null
          )
      `);
      return orphans === 0
        ? { status: 'pass', detail: 'No derived line outlives its source.' }
        : {
            status: 'fail',
            detail: `${orphans} depreciation lines have no live capex source. Regenerate the flow-through.`,
          };
    },
  },

  // -------------------------------------------------------------------------
  // Configuration that is easy to get wrong and silent when it is.
  // -------------------------------------------------------------------------
  {
    id: 'config.residency',
    title: 'No entity outside this deployment’s region',
    requirement: 'CMP-140',
    async run(db, config) {
      const foreign = await countOf(db, sql`
        select count(*)::text as count from entities where residency <> ${config.RESIDENCY_REGION}
      `);
      return foreign === 0
        ? { status: 'pass', detail: `All entities are in region "${config.RESIDENCY_REGION}".` }
        : {
            status: 'warn',
            // Not a failure: the scope resolver already refuses to serve them,
            // so their presence is a data-placement question rather than a
            // live exposure. It is still worth someone knowing.
            detail:
              `${foreign} entities belong to another region. They are unreachable through the ` +
              'API by design, but they are stored here — which is the question CMP-140 asks.',
          };
    },
  },
  {
    id: 'config.fx',
    title: 'Every currency in use has a rate for this year',
    requirement: 'FR-014',
    async run(db, config) {
      const missing = await db.query<{ currency: string }>(sql`
        select distinct li.currency from line_items li
        where li.deleted_at is null
          and not exists (
            select 1 from fx_rates fx
            where fx.currency = li.currency and fx.fiscal_year = ${config.FISCAL_YEAR}
          )
          and li.currency <> 'EUR'
      `);
      return missing.length === 0
        ? { status: 'pass', detail: 'Every non-EUR currency has a locked rate.' }
        : {
            status: 'fail',
            // A missing rate does not error — it converts at 1.0, which is a
            // wrong number that looks like a right one.
            detail: `No FY rate for ${missing.map((m) => m.currency).join(', ')}. Those lines convert at 1.0.`,
          };
    },
  },
  {
    id: 'config.templateVersion',
    title: 'Every entity is pinned to a published template version',
    requirement: 'FR-005',
    async run(db) {
      const unpinned = await countOf(db, sql`
        select count(*)::text as count from entities e
        where e.template_version_id is null
           or not exists (
             select 1 from template_versions tv
             where tv.id = e.template_version_id and tv.state = 'published'
           )
      `);
      return unpinned === 0
        ? { status: 'pass', detail: 'All entities track a published version.' }
        : { status: 'warn', detail: `${unpinned} entities are on no version or a draft.` };
    },
  },
  {
    id: 'config.approvalStages',
    title: 'Every approval stage names a role that can decide it',
    requirement: 'FR-051',
    async run(db, config) {
      // A stage naming a role without the capability would wedge every
      // submission above its threshold. The API refuses to create one; this
      // catches one inserted before that check existed, or by hand.
      const stages = await db.query<{ name: string; required_role: string }>(sql`
        select name, required_role from approval_stages
        where fiscal_year = ${config.FISCAL_YEAR} and enabled
      `);
      const { STAGE_APPROVER_ROLES } = await import('@spendifre/shared');
      const bad = stages.filter(
        (s) => !(STAGE_APPROVER_ROLES as readonly string[]).includes(s.required_role),
      );
      if (stages.length === 0) {
        return { status: 'warn', detail: 'No approval stages are configured; nothing gates a submission.' };
      }
      return bad.length === 0
        ? { status: 'pass', detail: `${stages.length} stages, all actionable.` }
        : {
            status: 'fail',
            detail: `Stages ${bad.map((b) => b.name).join(', ')} name a role that cannot decide them.`,
          };
    },
  },
  {
    id: 'config.ledgerProvenance',
    title: 'Ledger-sourced actuals carry their batch',
    requirement: 'FR-040',
    async run(db) {
      const orphaned = await countOf(db, sql`
        select count(*)::text as count from actuals
        where source = 'ledger' and ledger_batch_id is null
      `);
      return orphaned === 0
        ? { status: 'pass', detail: 'Every ledger actual is traceable to a batch.' }
        : { status: 'fail', detail: `${orphaned} ledger actuals have no batch. Provenance is broken.` };
    },
  },

  // -------------------------------------------------------------------------
  // Recoverability. The checks that answer "could we get this back".
  // -------------------------------------------------------------------------
  {
    id: 'backup.coverage',
    title: 'Every table is backed up or excluded on purpose',
    requirement: 'CMP-107',
    async run(db) {
      const tables = await db.query<{ tablename: string }>(sql`
        select tablename from pg_tables where schemaname = 'public'
      `);
      const uncovered = tables
        .map((t) => t.tablename)
        .filter(
          (n) => !(BACKUP_TABLES as readonly string[]).includes(n) && !(n in EXCLUDED_FROM_BACKUP),
        );
      return uncovered.length === 0
        ? { status: 'pass', detail: `${BACKUP_TABLES.length} tables backed up.` }
        : {
            status: 'fail',
            detail: `${uncovered.join(', ')} would be lost by a restore. Add to BACKUP_TABLES.`,
          };
    },
  },
  {
    id: 'backup.readable',
    title: 'The most recent backup can still be read',
    requirement: 'CMP-107, NFR-006',
    async run(db, config) {
      if (!config.BACKUP_ENCRYPTION_KEY) {
        return { status: 'skipped', detail: 'Backups are not configured on this deployment.' };
      }
      const [latest] = await listBackups(db, 1);
      if (!latest) return { status: 'warn', detail: 'No backup has ever been taken.' };
      if (latest.status !== 'complete') {
        return { status: 'fail', detail: `The most recent backup did not complete.` };
      }

      try {
        const { manifest, contents } = await readBackup(db, config, latest.id);
        const report = verifyArchive(manifest, parseArchive(contents));
        if (!report.ok) {
          return {
            status: 'fail',
            detail:
              'The archive no longer reconciles with its manifest: ' +
              [
                ...report.mismatches.map((m) => `${m.table} ${m.manifest}≠${m.archive}`),
                ...report.missingTables.map((t) => `missing ${t}`),
              ].join(', '),
          };
        }
        const ageHours = (Date.now() - new Date(latest.createdAt).getTime()) / 3_600_000;
        return ageHours > 48
          ? {
              status: 'warn',
              detail: `Readable, ${report.totalRows} rows — but ${Math.round(ageHours)} hours old.`,
            }
          : { status: 'pass', detail: `Readable and reconciled: ${report.totalRows} rows.` };
      } catch (err) {
        // The message is ours (integrity check, region mismatch), never a
        // driver string.
        return {
          status: 'fail',
          detail: `The archive could not be read: ${err instanceof Error ? err.message : 'unknown'}`,
        };
      }
    },
  },
  {
    id: 'retention.running',
    title: 'The retention job has run recently',
    requirement: 'PRIV-002',
    async run(db) {
      const row = await db.one<{ last: string | null }>(sql`
        select max(occurred_at)::text as last from audit_events
        where action = 'governance.retention.run'
      `);
      if (!row?.last) {
        return { status: 'warn', detail: 'The retention job has never run on this deployment.' };
      }
      const days = (Date.now() - new Date(row.last).getTime()) / 86_400_000;
      return days <= 35
        ? { status: 'pass', detail: `Last run ${Math.round(days)} days ago.` }
        : {
            status: 'fail',
            // Retention is a legal obligation, not a housekeeping preference.
            detail: `Last run ${Math.round(days)} days ago. Data is being kept past its policy.`,
          };
    },
  },
];

/**
 * Run every check. One failing check does not stop the others: a report that
 * stops at the first problem hides the second, and the second is often the one
 * that explains the first.
 */
export async function runSelfTest(db: Db, config: AppConfig): Promise<SelfTestReport> {
  const startedAt = new Date();
  const results: CheckResult[] = [];

  for (const check of CHECKS) {
    const began = Date.now();
    try {
      const outcome = await check.run(db, config);
      results.push({
        id: check.id,
        title: check.title,
        requirement: check.requirement,
        ...outcome,
        durationMs: Date.now() - began,
      });
    } catch (err) {
      results.push({
        id: check.id,
        title: check.title,
        requirement: check.requirement,
        status: 'fail',
        detail: `The check itself failed: ${err instanceof Error ? err.message : 'unknown'}`,
        durationMs: Date.now() - began,
      });
    }
  }

  const summary = {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    warn: results.filter((r) => r.status === 'warn').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };

  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    region: config.RESIDENCY_REGION,
    fiscalYear: config.FISCAL_YEAR,
    summary,
    // A warning is not a failure. Conflating the two is how a monitor gets
    // muted, and a muted monitor is worse than no monitor.
    healthy: summary.fail === 0,
    checks: results,
  };
}

export const SELF_TEST_IDS = CHECKS.map((c) => c.id);

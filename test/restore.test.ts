/**
 * Backup restore (`CMP-107`, `NFR-006`).
 *
 * "We have a backup" and "we can restore it" are different claims, and only the
 * second one matters at 3am. These tests make the second one checkable: a real
 * backup is taken from a seeded database, restored into a second, empty one,
 * and the two are compared row for row — including the audit hash chain, which
 * is the part a restore is most likely to break and least likely to be noticed
 * breaking.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDb, identifier, sql, type Db } from '../packages/api/src/db/pool.ts';
import { migrate } from '../packages/api/src/db/migrate.ts';
import {
  BACKUP_TABLES,
  EXCLUDED_FROM_BACKUP,
  createBackup,
  readBackup,
} from '../packages/api/src/services/backup.ts';
import {
  parseArchive,
  restoreInto,
  verifyArchive,
} from '../packages/api/src/services/restore.ts';
import { createHarness, type Harness } from './harness.ts';

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgres://postgres:devonly_postgres@127.0.0.1:5432/postgres';

let harness: Harness;
let targetDb: Db;
let targetName: string;

beforeAll(async () => {
  harness = await createHarness();

  // A second, separately migrated database to restore into. Restoring over the
  // source would prove nothing — it would pass even if the restore were a no-op.
  targetName = `spendifre_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  if (!/^spendifre_test_[a-z0-9]{16}$/.test(targetName)) throw new Error('bad db name');

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // eslint-disable-next-line no-restricted-syntax -- generated identifier, validated above
  await admin.query(`create database ${targetName}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${targetName}`;
  await migrate(url.toString());
  targetDb = createDb({ ...harness.config, DATABASE_URL: url.toString() });
}, 120_000);

afterAll(async () => {
  await targetDb?.close?.();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // eslint-disable-next-line no-restricted-syntax -- same generated identifier
  await admin.query(`drop database if exists ${targetName} with (force)`);
  await admin.end();
  await harness?.close();
});

describe('backup table allow-list', () => {
  /**
   * The allow-list is maintained by hand. Its original comment claimed a
   * missing table would be "noticed"; five tables added in one change were not,
   * and a backup taken in between would have silently omitted the approval
   * workflow. This test is what "noticed" actually costs.
   */
  it('covers every table in the schema, or excludes it on purpose', async () => {
    const tables = await harness.db.query<{ tablename: string }>(sql`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `);

    const uncovered = tables
      .map((t) => t.tablename)
      .filter(
        (name) =>
          !(BACKUP_TABLES as readonly string[]).includes(name) &&
          !(name in EXCLUDED_FROM_BACKUP),
      );

    expect(
      uncovered,
      `these tables are neither backed up nor explicitly excluded:\n${uncovered.join('\n')}\n` +
        'Add them to BACKUP_TABLES, or to EXCLUDED_FROM_BACKUP with a reason.',
    ).toEqual([]);
  });

  it('does not exclude a table that no longer exists', async () => {
    const tables = await harness.db.query<{ tablename: string }>(sql`
      select tablename from pg_tables where schemaname = 'public'
    `);
    const live = new Set(tables.map((t) => t.tablename));
    // A stale exclusion is a comment claiming a decision about nothing.
    const stale = Object.keys(EXCLUDED_FROM_BACKUP).filter((t) => !live.has(t));
    expect(stale).toEqual([]);
  });
});

describe('CMP-107 restore', () => {
  let backupId: string;
  let sourceCounts: Record<string, number>;

  it('takes a backup that reconciles with its own manifest', async () => {
    const principal = {
      userId: (await harness.db.one<{ id: string }>(sql`
        select id from users where role = 'admin' limit 1
      `))!.id,
      role: 'admin' as const,
      ownedEntityIds: [],
    };

    const manifest = await createBackup(harness.db, harness.config, principal);
    backupId = manifest.id;
    sourceCounts = manifest.rowCounts;

    expect(manifest.status).toBe('complete');
    expect(manifest.auditChainIntact).toBe(true);

    const { contents } = await readBackup(harness.db, harness.config, backupId);
    const report = verifyArchive(manifest, parseArchive(contents));

    expect(report.mismatches).toEqual([]);
    expect(report.missingTables).toEqual([]);
    expect(report.unknownTables).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);

  it('restores into an empty database with matching row counts', async () => {
    const { manifest, contents } = await readBackup(harness.db, harness.config, backupId);
    const parsed = parseArchive(contents);

    const result = await restoreInto(targetDb, parsed, manifest, {
      confirmBackupId: backupId,
      region: harness.config.RESIDENCY_REGION,
    });

    expect(result.referentialFailures).toEqual([]);
    expect(result.rowsRestored).toBeGreaterThan(0);

    // Compare every table, not a sample: a restore that dropped one table
    // would otherwise pass whenever the sample missed it.
    for (const table of BACKUP_TABLES) {
      const row = await targetDb.one<{ count: string }>(
        sql`select count(*)::text as count from ${identifier(table, [...BACKUP_TABLES])}`,
      );
      expect(Number(row!.count), `row count for ${table}`).toBe(sourceCounts[table] ?? 0);
    }
  }, 120_000);

  it('restores an audit chain that still verifies', async () => {
    // The claim that makes a restored database trustworthy. A restore that
    // reordered or altered a single audit row would fail here.
    const chain = await targetDb.one<{ bad: string | null }>(sql`
      select audit_verify_chain()::text as bad
    `);
    expect(chain!.bad).toBeNull();
  });

  it('re-anchors the chain so the next event links to what was restored', async () => {
    const anchor = await targetDb.one<{ head_seq: string | null }>(sql`
      select head_seq::text from audit_chain_anchor
    `);
    const head = await targetDb.one<{ seq: string | null }>(sql`
      select max(seq)::text as seq from audit_events
    `);
    expect(anchor!.head_seq).toBe(head!.seq);
  });

  it('preserves figures exactly, not approximately', async () => {
    // Money is the reason this system exists. A restore that lost precision
    // would still pass a row-count check.
    const source = await harness.db.one<{ total: string }>(sql`
      select coalesce(sum(amount), 0)::text as total from period_amounts
    `);
    const restored = await targetDb.one<{ total: string }>(sql`
      select coalesce(sum(amount), 0)::text as total from period_amounts
    `);
    expect(restored!.total).toBe(source!.total);
  });

  it('preserves the derived-line self-reference', async () => {
    const orphans = await targetDb.one<{ count: string }>(sql`
      select count(*)::text as count from line_items li
      where li.derived_from_line_id is not null
        and not exists (select 1 from line_items p where p.id = li.derived_from_line_id)
    `);
    expect(orphans!.count).toBe('0');
  });

  it('refuses a confirmation that does not match the backup id', async () => {
    const { manifest, contents } = await readBackup(harness.db, harness.config, backupId);
    await expect(
      restoreInto(targetDb, parseArchive(contents), manifest, {
        confirmBackupId: '00000000-0000-4000-8000-000000000000',
        region: harness.config.RESIDENCY_REGION,
      }),
    ).rejects.toThrow(/confirmation does not match/);
  });

  it('refuses a restore across a region boundary', async () => {
    const { manifest, contents } = await readBackup(harness.db, harness.config, backupId);
    await expect(
      restoreInto(targetDb, parseArchive(contents), manifest, {
        confirmBackupId: backupId,
        region: 'cn',
      }),
    ).rejects.toThrow(/belongs to region/);
  });
});

describe('archive parsing', () => {
  it('refuses an archive with no header', () => {
    expect(() => parseArchive(Buffer.from('{"table":"users","row":{}}\n'))).toThrow(
      /not spendifre-backup-v1/,
    );
  });

  it('refuses a row naming a table outside the allow-list', () => {
    const archive =
      `${JSON.stringify({ _meta: { format: 'spendifre-backup-v1', region: 'eu', fiscalYear: 2026, tables: [] } })}\n` +
      `${JSON.stringify({ table: 'pg_shadow', row: { x: 1 } })}\n`;
    expect(() => parseArchive(Buffer.from(archive))).toThrow(/unknown table/);
  });

  it('refuses a line that is not valid JSON', () => {
    const archive =
      `${JSON.stringify({ _meta: { format: 'spendifre-backup-v1', region: 'eu', fiscalYear: 2026, tables: [] } })}\n` +
      'not json\n';
    expect(() => parseArchive(Buffer.from(archive))).toThrow(/not valid JSON/);
  });

  it('reports a table the archive predates', () => {
    const archive = `${JSON.stringify({
      _meta: {
        format: 'spendifre-backup-v1',
        region: 'eu',
        fiscalYear: 2026,
        // An archive written before approval stages existed.
        tables: BACKUP_TABLES.filter((t) => t !== 'approval_stages'),
      },
    })}\n`;
    const report = verifyArchive(
      {
        id: 'x', createdAt: '', createdBy: '', region: 'eu', status: 'complete',
        byteSize: '0', sha256: null, rowCounts: {}, auditHeadSeq: null,
        auditChainIntact: true,
      },
      parseArchive(Buffer.from(archive)),
    );
    // Restoring this leaves approval_stages empty. Silence would be the bug.
    expect(report.ok).toBe(false);
    expect(report.missingTables).toContain('approval_stages');
  });
});

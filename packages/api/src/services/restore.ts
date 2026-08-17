/**
 * Restore from a backup (`CMP-107`, `NFR-006`).
 *
 * Two operations with very different risk, kept apart on purpose.
 *
 *   verifyArchive   Decrypts, parses and checks an archive against its own
 *                   manifest. Writes nothing. Safe to run on a schedule against
 *                   production, which is what makes "we have a tested restore
 *                   path" a claim someone can check rather than assert.
 *
 *   restoreInto     Replaces the contents of a target database. Destructive.
 *
 * **`restoreInto` is not reachable from the API, and that is deliberate.** It
 * needs to truncate `audit_events`, which the application role cannot do by
 * grant (SEC-021) and the append-only trigger would refuse anyway. Giving the
 * running service the rights to erase its own audit trail would defeat the
 * control that makes the trail worth having — so restore is an owner-level
 * operation run out of band by `tools/restore.ts`, with the migrator's
 * credentials, against a database someone deliberately pointed it at.
 *
 * The archive is authenticated before it reaches this module: SHA-256 over the
 * ciphertext, AES-256-GCM's auth tag, and AAD binding it to its backup id and
 * region. So its *contents* are trusted to the extent of being ours. Its
 * *shape* is not: table names are checked against the backup allow-list and
 * column names against the live schema, because a bug in the writer must not
 * become a schema-shaped injection in the reader.
 */

import type { Db } from '../db/pool.ts';
import { identifier, join, sql } from '../db/pool.ts';
import { BACKUP_TABLES, type BackupManifest } from './backup.ts';

const FORMAT = 'spendifre-backup-v1';

export interface ArchiveMeta {
  format: string;
  region: string;
  fiscalYear: number;
  tables: readonly string[];
}

export interface ParsedArchive {
  meta: ArchiveMeta;
  /** Rows grouped by table, in the archive's own order. */
  rows: Map<string, Record<string, unknown>[]>;
  rowCounts: Record<string, number>;
  totalRows: number;
}

export interface VerifyReport {
  ok: boolean;
  backupId: string;
  region: string;
  format: string;
  totalRows: number;
  /** Tables where the archive and the manifest disagree. Empty when ok. */
  mismatches: { table: string; manifest: number; archive: number }[];
  /** Tables in the archive that this build would not restore. Empty when ok. */
  unknownTables: string[];
  /** Tables this build expects that the archive does not carry. */
  missingTables: string[];
  auditChainIntactAtCapture: boolean | null;
}

/**
 * Parse a decrypted archive.
 *
 * Line-oriented, so a large archive is read one row at a time rather than
 * materialised as a single JSON document. Any line that is not valid JSON, or
 * names a table outside the allow-list, fails the whole parse — a partially
 * understood archive is more dangerous than an unreadable one.
 */
export function parseArchive(contents: Buffer): ParsedArchive {
  const lines = contents.toString('utf8').split('\n');
  let meta: ArchiveMeta | null = null;
  const rows = new Map<string, Record<string, unknown>[]>();
  let totalRows = 0;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`archive line ${index + 1} is not valid JSON`);
    }

    if (index === 0) {
      const header = (parsed as { _meta?: ArchiveMeta })._meta;
      if (!header || header.format !== FORMAT) {
        throw new Error(`archive is not ${FORMAT}`);
      }
      meta = header;
      continue;
    }

    const entry = parsed as { table?: string; row?: Record<string, unknown> };
    if (typeof entry.table !== 'string' || !entry.row || typeof entry.row !== 'object') {
      throw new Error(`archive line ${index + 1} is not a table row`);
    }
    if (!(BACKUP_TABLES as readonly string[]).includes(entry.table)) {
      throw new Error(`archive line ${index + 1} names an unknown table "${entry.table}"`);
    }

    const list = rows.get(entry.table) ?? [];
    list.push(entry.row);
    rows.set(entry.table, list);
    totalRows += 1;
  }

  if (!meta) throw new Error('archive has no header');

  const rowCounts: Record<string, number> = {};
  for (const [table, list] of rows) rowCounts[table] = list.length;

  return { meta, rows, rowCounts, totalRows };
}

/**
 * Check an archive against the manifest that describes it, and against what
 * this build knows how to restore.
 *
 * The interesting failure is `missingTables`: an archive written before a table
 * existed restores cleanly and silently leaves that table empty. Naming it is
 * the difference between a restore someone can trust and one they find out
 * about later.
 */
export function verifyArchive(manifest: BackupManifest, parsed: ParsedArchive): VerifyReport {
  const mismatches: VerifyReport['mismatches'] = [];
  for (const [table, expected] of Object.entries(manifest.rowCounts)) {
    const actual = parsed.rowCounts[table] ?? 0;
    if (actual !== expected) mismatches.push({ table, manifest: expected, archive: actual });
  }

  const carried = new Set(parsed.meta.tables);
  const unknownTables = [...carried].filter(
    (t) => !(BACKUP_TABLES as readonly string[]).includes(t),
  );
  const missingTables = BACKUP_TABLES.filter((t) => !carried.has(t));

  return {
    ok: mismatches.length === 0 && unknownTables.length === 0 && missingTables.length === 0,
    backupId: manifest.id,
    region: manifest.region,
    format: parsed.meta.format,
    totalRows: parsed.totalRows,
    mismatches,
    unknownTables,
    missingTables: [...missingTables],
    auditChainIntactAtCapture: manifest.auditChainIntact,
  };
}

export interface RestoreResult {
  tablesRestored: number;
  rowsRestored: number;
  /** Null when the chain verified; otherwise the first bad sequence. */
  auditChainBreakAt: string | null;
  /** Rows that failed a referential check after constraints were re-enabled. */
  referentialFailures: string[];
}

export interface RestoreOptions {
  /** Must equal the backup id. A second, deliberate confirmation. */
  confirmBackupId: string;
  /** The region the target deployment serves; must match the archive's. */
  region: string;
}

/**
 * Replace the target database's contents with the archive.
 *
 * Runs in one transaction, with replication-role trickery for the duration:
 *
 *   `session_replication_role = replica` suspends user triggers and foreign-key
 *   checks. It is what `pg_restore` does, and it is needed twice over here —
 *   `line_items.derived_from_line_id` is self-referential so no insertion order
 *   satisfies it, and `audit_events` carries an immutability trigger that would
 *   refuse the insert. Both are re-enabled before the transaction commits, and
 *   referential integrity is then checked explicitly rather than assumed.
 *
 * This requires the table owner's rights. The application role does not have
 * them, by design.
 */
export async function restoreInto(
  db: Db,
  parsed: ParsedArchive,
  manifest: BackupManifest,
  options: RestoreOptions,
): Promise<RestoreResult> {
  if (options.confirmBackupId !== manifest.id) {
    throw new Error('confirmation does not match the backup id');
  }
  // The same rule that governs live data governs its copies (SPEC §9.4).
  if (manifest.region !== options.region) {
    throw new Error(
      `backup belongs to region "${manifest.region}"; this target serves "${options.region}"`,
    );
  }

  return db.transaction(async (tx) => {
    await tx.query(sql`set local session_replication_role = replica`);

    let rowsRestored = 0;
    let tablesRestored = 0;

    // Truncate in reverse dependency order, then fill forward.
    for (const table of [...BACKUP_TABLES].reverse()) {
      const safe = identifier(table, [...BACKUP_TABLES]);
      await tx.query(sql`delete from ${safe}`);
    }

    for (const table of BACKUP_TABLES) {
      const list = parsed.rows.get(table);
      if (!list || list.length === 0) continue;

      const safe = identifier(table, [...BACKUP_TABLES]);

      // Column names come from the archive, so they are checked against the
      // live schema before being interpolated. A column the archive carries and
      // this schema does not is a hard error: silently dropping it would mean a
      // restore that lost data without saying so.
      const schema = await tx.query<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = ${table}
      `);
      const known = schema.map((c) => c.column_name);
      const columns = Object.keys(list[0]!);
      for (const column of columns) {
        if (!known.includes(column)) {
          throw new Error(`archive column "${table}.${column}" does not exist in this schema`);
        }
      }

      const safeColumns = columns.map((c) => identifier(c, known));
      const columnList = join(safeColumns.map((c) => sql`${c}`), ', ');

      for (const row of list) {
        const values = join(columns.map((c) => sql`${normalise(row[c])}`), ', ');
        await tx.query(sql`insert into ${safe} (${columnList}) values (${values})`);
        rowsRestored += 1;
      }
      tablesRestored += 1;
    }

    // Re-anchor to the *earliest* restored row, not the latest.
    //
    // `audit_verify_chain()` starts from the anchor and walks forward from the
    // lowest sequence, so the anchor has to be what the first surviving row
    // claims as its predecessor. Anchoring to the head instead makes
    // verification fail at row one — and it fails invisibly on a chain of
    // length one, where the first and last row are the same row, which is
    // exactly how this survived its first test.
    await tx.query(sql`
      update audit_chain_anchor
      set head_hash = coalesce(
            (select prev_hash from audit_events order by seq limit 1),
            head_hash
          ),
          head_seq = coalesce((select min(seq) - 1 from audit_events), 0),
          anchored_at = now()
    `);

    await tx.query(sql`set local session_replication_role = origin`);

    // Constraints were suspended, so integrity is now checked rather than
    // assumed. `validate constraint` would need each name; this asks the
    // question that actually matters for the two self-referential links.
    const referentialFailures: string[] = [];
    const orphanDerived = await tx.one<{ count: string }>(sql`
      select count(*)::text as count from line_items li
      where li.derived_from_line_id is not null
        and not exists (select 1 from line_items p where p.id = li.derived_from_line_id)
    `);
    if (Number(orphanDerived?.count ?? 0) > 0) {
      referentialFailures.push(`${orphanDerived!.count} derived lines with no source line`);
    }
    const orphanActuals = await tx.one<{ count: string }>(sql`
      select count(*)::text as count from actuals a
      where a.ledger_batch_id is not null
        and not exists (select 1 from ledger_batches b where b.id = a.ledger_batch_id)
    `);
    if (Number(orphanActuals?.count ?? 0) > 0) {
      referentialFailures.push(`${orphanActuals!.count} actuals referencing a missing batch`);
    }

    // The claim that makes a restore trustworthy: the audit chain that arrived
    // in the archive still verifies once it is back in a database.
    const chain = await tx.one<{ bad: string | null }>(sql`
      select audit_verify_chain()::text as bad
    `);

    return {
      tablesRestored,
      rowsRestored,
      auditChainBreakAt: chain?.bad ?? null,
      referentialFailures,
    };
  });
}

/**
 * `row_to_json` renders every value as JSON, so what comes back is a string, a
 * number, a boolean, null, or a nested object/array for `jsonb` and array
 * columns. Objects and arrays are re-serialised; everything else is passed
 * through and let the driver bind it.
 */
function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

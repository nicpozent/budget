/**
 * Admin-triggered backup (`backup.run`, `backup.download`).
 *
 * A backup is the single most sensitive artefact this system produces: it is
 * every figure, every comment, every personal record and the entire audit
 * trail, in one file, outside the database's access controls. So it is built
 * defensively:
 *
 *   Encrypted at rest.   AES-256-GCM with a key that lives in the environment
 *                        (Key Vault in production, ZT-006) and is never stored
 *                        alongside the archive. A stolen backup file is inert.
 *
 *   Integrity stamped.   SHA-256 of the ciphertext in the manifest, plus GCM's
 *                        own auth tag. Tampering is detected on read, not
 *                        discovered at restore time.
 *
 *   Chain-attested.      The manifest records `audit_verify_chain()` and the
 *                        head sequence at the moment of capture. A backup that
 *                        caught a broken chain is evidence of *when* it broke;
 *                        without that field it would just be a file.
 *
 *   Region stamped.      A backup carries the residency of the deployment that
 *                        made it, so a restore into another region is a
 *                        detectable mistake rather than a silent border
 *                        crossing (SPEC §9.4, CMP-140).
 *
 * Storage keys are derived from the backup's own UUID. No request input reaches
 * a path, so the traversal class cannot occur.
 *
 * Tables are dumped from a fixed allow-list, not from `information_schema`. A
 * new table is therefore absent from backups until someone adds it here — which
 * is the failure we want (a missing table is noticed) rather than the one we do
 * not (an unreviewed table silently exported).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Principal } from '@spendifre/shared';
import type { Db } from '../db/pool.ts';
import { identifier, sql } from '../db/pool.ts';
import type { AppConfig } from '../config.ts';
import { badRequest, internal, notFound } from '../http/errors.ts';
import { writeAudit } from './audit.ts';
import { auditChainIntact, exportedRows } from '../observability/metrics.ts';

/**
 * Every table that belongs in a backup, in dependency order so a restore can
 * replay it top to bottom.
 *
 * `sessions` and `auth_transactions` are deliberately absent: they are live
 * credentials, not records. Including them would put session material into an
 * archive that outlives the sessions themselves, for no restore value.
 */
export const BACKUP_TABLES = [
  'users',
  // Before `entities` and `template_fields`, both of which reference it.
  'template_versions',
  'entities',
  'entity_owners',
  'categories',
  'cost_centres',
  // Before `actuals`, which references a batch when the row came from a feed.
  'ledger_batches',
  'ledger_batch_rejects',
  'line_items',
  // Before `period_amounts`, whose (fiscal_year, budget_version) references it.
  // After `cycles`? No — `cycles` is written later and the restore suspends
  // foreign keys wholesale, so this ordering is for a human reading the archive
  // rather than for the loader.
  'budget_versions',
  'period_amounts',
  'actuals',
  'line_comments',
  'fx_rates',
  'drivers',
  // After `drivers`: a term references one by (entity, key, year).
  'driver_terms',
  'allocation_pools',
  'template_fields',
  'cycles',
  'cycle_exceptions',
  'validation_rules',
  'approval_stages',
  'submissions',
  'submission_line_decisions',
  'submission_stage_decisions',
  'reminders',
  'data_classifications',
  'retention_policies',
  'audit_events',
] as const;

/**
 * Tables deliberately excluded, with the reason. Every table in the schema must
 * appear here or in `BACKUP_TABLES`; `test/operations.test.ts` asserts that
 * against the live schema.
 *
 * The original comment here claimed a missing table would be "noticed". It was
 * not: five tables added in one change went unbacked-up until the test below
 * was written. An allow-list without a completeness check is a list that drifts.
 */
export const EXCLUDED_FROM_BACKUP: Readonly<Record<string, string>> = Object.freeze({
  sessions: 'live credentials, not records — would outlive the sessions themselves',
  auth_transactions: 'in-flight OIDC state, seconds-lived',
  backups: 'the manifest of the archive being written; restoring it would be circular',
  audit_chain_anchor: 'rebuilt by the restore, not carried by it',
  schema_migrations: 'owned by the migration runner; a restore targets an already-migrated schema',
  countries:
    'reference data written by migration 011, so an already-migrated restore target ' +
    'already has it — and carrying it would let an old archive delete a country added since',
});

export interface BackupManifest {
  id: string;
  createdAt: string;
  createdBy: string;
  region: string;
  status: 'complete' | 'failed';
  byteSize: string;
  sha256: string | null;
  rowCounts: Record<string, number>;
  auditHeadSeq: string | null;
  auditChainIntact: boolean | null;
}

function keyFromConfig(config: AppConfig): Buffer {
  if (!config.BACKUP_ENCRYPTION_KEY) {
    throw badRequest('backups are not configured on this deployment');
  }
  const key = Buffer.from(config.BACKUP_ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) {
    throw internal('BACKUP_ENCRYPTION_KEY must be 32 bytes of hex');
  }
  return key;
}

/** Storage key derived from the backup id alone — never from request input. */
function storageKeyFor(id: string): string {
  return `${id}.jsonl.gz.enc`;
}

function resolveStoragePath(config: AppConfig, storageKey: string): string {
  // `storageKey` is generated from a UUID we minted, and re-checked here so a
  // future caller cannot pass something else in.
  if (!/^[0-9a-f-]{36}\.jsonl\.gz\.enc$/.test(storageKey)) {
    throw internal('malformed storage key');
  }
  return path.join(config.BACKUP_DIR, storageKey);
}

export async function createBackup(
  db: Db,
  config: AppConfig,
  principal: Principal,
  request?: Parameters<typeof writeAudit>[1]['request'],
): Promise<BackupManifest> {
  const key = keyFromConfig(config);

  // Reserve the manifest row first, so a crash mid-dump leaves a record that
  // something was attempted rather than nothing at all.
  const reserved = await db.one<{ id: string }>(sql`
    insert into backups (created_by, region, status, storage_key)
    values (${principal.userId}, ${config.RESIDENCY_REGION}, 'failed', 'pending')
    returning id
  `);
  if (!reserved) throw internal('could not reserve a backup');
  const id = reserved.id;

  try {
    const rowCounts: Record<string, number> = {};
    const chunks: string[] = [];

    // A JSON Lines archive: one object per row, prefixed by a table marker.
    // Line-oriented so a restore can stream it rather than parse 100 MB of
    // JSON in one go.
    chunks.push(
      `${JSON.stringify({
        _meta: {
          format: 'spendifre-backup-v1',
          region: config.RESIDENCY_REGION,
          fiscalYear: config.FISCAL_YEAR,
          tables: BACKUP_TABLES,
        },
      })}\n`,
    );

    for (const table of BACKUP_TABLES) {
      // Allow-list, checked by equality — this is the one place a table name is
      // interpolated, and it can only ever be a member of BACKUP_TABLES.
      const safeTable = identifier(table, [...BACKUP_TABLES]);
      const rows = await db.query<Record<string, unknown>>(sql`
        select row_to_json(t) as row from ${safeTable} t
      `);
      rowCounts[table] = rows.length;
      for (const row of rows) {
        chunks.push(`${JSON.stringify({ table, row: row.row })}\n`);
      }
    }

    // CMP-103: attest the chain state at capture time.
    const chain = await db.one<{ bad: string | null }>(sql`
      select audit_verify_chain()::text as bad
    `);
    const head = await db.one<{ seq: string | null }>(sql`
      select max(seq)::text as seq from audit_events
    `);

    const plaintext = gzipSync(Buffer.from(chunks.join(''), 'utf8'), { level: 9 });

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    // Bind the ciphertext to this backup's identity and region. A blob moved
    // between manifests, or restored into the wrong region, fails to decrypt
    // rather than quietly succeeding.
    cipher.setAAD(Buffer.from(`${id}:${config.RESIDENCY_REGION}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const sha256 = createHash('sha256').update(ciphertext).digest();

    const storageKey = storageKeyFor(id);
    await mkdir(config.BACKUP_DIR, { recursive: true });
    await writeFile(resolveStoragePath(config, storageKey), ciphertext, { mode: 0o600 });

    await db.query(sql`
      update backups set
        status = 'complete',
        byte_size = ${ciphertext.length},
        sha256 = ${sha256},
        iv = ${iv},
        auth_tag = ${authTag},
        row_counts = ${JSON.stringify(rowCounts)}::jsonb,
        audit_head_seq = ${head?.seq ? Number(head.seq) : null},
        audit_chain_intact = ${chain?.bad === null},
        storage_key = ${storageKey}
      where id = ${id}
    `);

    const totalRows = Object.values(rowCounts).reduce((n, c) => n + c, 0);
    // ZT-008 alert 2. A backup is the largest single export the system makes,
    // so its row count is the number an alert should threshold on.
    exportedRows({ kind: 'backup' }, totalRows);
    auditChainIntact(chain?.bad === null ? 1 : 0);
    await writeAudit(db, {
      actor: principal,
      action: 'backup.create',
      targetType: 'backup',
      targetId: id,
      // ZT-008 asks for an alert on mass export. The counts are here so the
      // SIEM rule has something to threshold on.
      detail:
        `Backup ${id}: ${totalRows} rows across ${BACKUP_TABLES.length} tables, ` +
        `${ciphertext.length} bytes encrypted, audit chain ` +
        `${chain?.bad === null ? 'intact' : `BROKEN at seq ${chain?.bad}`}`,
      kind: 'governance',
      ...(request ? { request } : {}),
    });

    return (await getBackup(db, id))!;
  } catch (err) {
    await db.query(sql`
      update backups set status = 'failed', error = ${String(err).slice(0, 1000)}
      where id = ${id}
    `);
    // The audit event still gets written: a failed backup is exactly the kind
    // of operational fact someone needs to see.
    await writeAudit(db, {
      actor: principal,
      action: 'backup.failed',
      targetType: 'backup',
      targetId: id,
      detail: `Backup ${id} failed`,
      kind: 'governance',
      ...(request ? { request } : {}),
    });
    throw err;
  }
}

export async function listBackups(db: Db, limit = 50): Promise<BackupManifest[]> {
  const rows = await db.query<{
    id: string;
    created_at: Date;
    created_by: string;
    region: string;
    status: 'complete' | 'failed';
    byte_size: string;
    sha256: Buffer | null;
    row_counts: Record<string, number>;
    audit_head_seq: string | null;
    audit_chain_intact: boolean | null;
  }>(sql`
    select b.id, b.created_at, coalesce(u.display_name, 'Removed user') as created_by,
           b.region, b.status, b.byte_size, b.sha256, b.row_counts,
           b.audit_head_seq, b.audit_chain_intact
    from backups b
    join users u on u.id = b.created_by
    order by b.created_at desc
    limit ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
    region: r.region,
    status: r.status,
    byteSize: String(r.byte_size),
    sha256: r.sha256 ? r.sha256.toString('hex') : null,
    rowCounts: r.row_counts,
    auditHeadSeq: r.audit_head_seq,
    auditChainIntact: r.audit_chain_intact,
  }));
}

async function getBackup(db: Db, id: string): Promise<BackupManifest | null> {
  const all = await listBackups(db, 200);
  return all.find((b) => b.id === id) ?? null;
}

/**
 * Reads a backup back, verifying integrity before returning anything.
 *
 * The SHA-256 is checked before decryption and GCM's auth tag during it, so a
 * modified archive fails twice over rather than yielding partially-trusted
 * plaintext.
 */
export async function readBackup(
  db: Db,
  config: AppConfig,
  id: string,
): Promise<{ manifest: BackupManifest; contents: Buffer }> {
  const key = keyFromConfig(config);

  const row = await db.one<{
    storage_key: string;
    sha256: Buffer | null;
    iv: Buffer | null;
    auth_tag: Buffer | null;
    region: string;
    status: string;
  }>(sql`
    select storage_key, sha256, iv, auth_tag, region, status
    from backups where id = ${id}
  `);
  if (!row || row.status !== 'complete') throw notFound('backup does not exist');

  // A backup from another region must not be served here — the same rule that
  // governs live data governs its copies.
  if (row.region !== config.RESIDENCY_REGION) {
    throw notFound('backup belongs to another region');
  }
  if (!row.iv || !row.auth_tag || !row.sha256) throw internal('backup manifest is incomplete');

  const ciphertext = await readFile(resolveStoragePath(config, row.storage_key));

  const actual = createHash('sha256').update(ciphertext).digest();
  if (!actual.equals(row.sha256)) {
    throw internal(`backup ${id} failed its integrity check`);
  }

  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAAD(Buffer.from(`${id}:${row.region}`, 'utf8'));
  decipher.setAuthTag(row.auth_tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const manifest = await getBackup(db, id);
  if (!manifest) throw notFound('backup does not exist');

  return { manifest, contents: gunzipSync(plaintext) };
}

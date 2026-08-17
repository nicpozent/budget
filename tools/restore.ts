/**
 * Disaster recovery: restore a Spendifre backup into a database.
 *
 *   node --experimental-strip-types tools/restore.ts \
 *     --backup <uuid> --confirm <uuid> [--target postgres://…] [--dry-run]
 *
 * Deliberately a command-line tool and not an API endpoint.
 *
 * A restore truncates `audit_events`. The application's database role cannot do
 * that — it holds no DELETE on audit, and the append-only trigger would refuse
 * regardless (SEC-021, FR-070). Adding an endpoint would mean granting the
 * running service the rights to erase its own audit trail, which is precisely
 * the capability the trail exists to deny. So this runs out of band, with the
 * owner's credentials, against a database someone deliberately named.
 *
 * Three deliberate frictions, because this is the most destructive operation in
 * the system:
 *
 *   1. `--confirm` must repeat the backup id. Not a y/n prompt — a value that
 *      cannot be supplied by muscle memory.
 *   2. The target is read from `RESTORE_DATABASE_URL`, never from
 *      `DATABASE_URL`. Pointing a restore at the live application database has
 *      to be something you typed on purpose.
 *   3. The archive's region must match `RESIDENCY_REGION`. A restore across a
 *      border is a detectable mistake (SPEC §9.4, CMP-140).
 *
 * `--dry-run` decrypts, parses and reconciles without writing, which is the
 * same check `POST /api/admin/backups/:id/verify` performs.
 */

import { loadConfig } from '../packages/api/src/config.ts';
import { createDb, sql } from '../packages/api/src/db/pool.ts';
import { readBackup } from '../packages/api/src/services/backup.ts';
import { parseArchive, restoreInto, verifyArchive } from '../packages/api/src/services/restore.ts';

interface Args {
  backup?: string;
  confirm?: string;
  target?: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--backup') args.backup = argv[++i];
    else if (flag === '--confirm') args.confirm = argv[++i];
    else if (flag === '--target') args.target = argv[++i];
  }
  return args;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.backup || !UUID.test(args.backup)) {
    console.error('usage: restore.ts --backup <uuid> --confirm <uuid> [--target url] [--dry-run]');
    process.exit(2);
  }

  const config = loadConfig(process.env);

  // The source database holds the manifest and the key material context; the
  // target is where rows land. They are usually different databases, and the
  // tool refuses to guess that they are the same.
  const source = createDb(config);

  const { manifest, contents } = await readBackup(source, config, args.backup);
  const parsed = parseArchive(contents);
  const report = verifyArchive(manifest, parsed);

  console.warn(`backup     ${manifest.id}`);
  console.warn(`taken      ${manifest.createdAt} by ${manifest.createdBy}`);
  console.warn(`region     ${manifest.region}`);
  console.warn(`rows       ${report.totalRows} across ${Object.keys(parsed.rowCounts).length} tables`);
  console.warn(`chain      ${manifest.auditChainIntact ? 'intact at capture' : 'BROKEN AT CAPTURE'}`);

  if (!report.ok) {
    console.error('\narchive did not reconcile with its manifest:');
    for (const m of report.mismatches) {
      console.error(`  ${m.table}: manifest ${m.manifest}, archive ${m.archive}`);
    }
    for (const t of report.missingTables) console.error(`  archive is missing ${t}`);
    for (const t of report.unknownTables) console.error(`  archive carries unknown ${t}`);
    // A backup that does not reconcile is still restorable in an emergency, but
    // it must not happen silently.
    console.error('\nrefusing to restore. Re-run with the mismatch understood.');
    await source.close?.();
    process.exit(1);
  }

  if (manifest.auditChainIntact === false) {
    console.warn(
      '\nWARNING: the audit chain was already broken when this backup was taken.\n' +
        'Restoring it reproduces that state. That is evidence of when the break\n' +
        'occurred, not something the restore introduced.',
    );
  }

  if (args.dryRun) {
    console.warn('\ndry run: archive is readable and reconciles. Nothing written.');
    await source.close?.();
    return;
  }

  if (args.confirm !== args.backup) {
    console.error('\n--confirm must repeat the backup id exactly. Nothing written.');
    await source.close?.();
    process.exit(2);
  }

  const targetUrl = args.target ?? process.env.RESTORE_DATABASE_URL;
  if (!targetUrl) {
    console.error(
      '\nset RESTORE_DATABASE_URL (or pass --target) to the database to restore into.\n' +
        'DATABASE_URL is deliberately not used: restoring over the live application\n' +
        'database has to be something you type on purpose.',
    );
    await source.close?.();
    process.exit(2);
  }

  const target = createDb({ ...config, DATABASE_URL: targetUrl });

  console.warn(`\nrestoring into ${redact(targetUrl)} …`);
  const result = await restoreInto(target, parsed, manifest, {
    confirmBackupId: args.confirm,
    region: config.RESIDENCY_REGION,
  });

  console.warn(`restored   ${result.rowsRestored} rows across ${result.tablesRestored} tables`);
  console.warn(
    `chain      ${result.auditChainBreakAt === null
      ? 'verifies after restore'
      : `BROKEN at seq ${result.auditChainBreakAt}`}`,
  );

  for (const failure of result.referentialFailures) {
    console.error(`integrity  ${failure}`);
  }

  // The restore is itself an event worth recording, and it is recorded in the
  // restored database — which is the one that will be asked about it later.
  await target.query(sql`
    insert into audit_events (actor_user_id, actor_role, action, target_type, target_id,
                              detail, kind)
    select id, 'admin', 'backup.restore', 'backup', ${manifest.id},
           ${`Restored backup ${manifest.id} (${result.rowsRestored} rows) taken ${manifest.createdAt}`},
           'governance'
    from users where role = 'admin' order by created_at limit 1
  `);

  await source.close?.();
  await target.close?.();

  const failed = result.auditChainBreakAt !== null || result.referentialFailures.length > 0;
  if (failed) {
    console.error('\nrestore completed with findings above. Do not treat this as clean.');
    process.exit(1);
  }
  console.warn('\nrestore complete and verified.');
}

/** Never print a password, even to a terminal someone is watching. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable url>';
  }
}

await main();

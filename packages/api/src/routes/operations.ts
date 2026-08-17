/**
 * Operations: backup, archive verification and the runtime self-test
 * (ADR 0005, CMP-107, NFR-006).
 *
 * Separate from governance because these act on the *deployment* rather than on
 * the data model: they answer "is this system healthy and recoverable", not
 * "what may we keep and who may see it". Every capability here is step-up
 * (ZT-007) and rate limited, and a backup is audited with its row count so
 * ZT-008 can alert on volume.
 *
 * Restore is deliberately absent. It truncates `audit_events`, which the
 * application role cannot do by grant and the append-only trigger would refuse
 * anyway; an endpoint would mean granting the running service the right to
 * erase its own audit trail. `npm run restore` is the tool, and what is offered
 * here instead is verification, which writes nothing.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { principalOf, requires } from '../http/guard.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { createBackup, listBackups, readBackup } from '../services/backup.ts';
import { parseArchive, verifyArchive } from '../services/restore.ts';
import { runSelfTest } from '../services/selftest.ts';

export async function registerOperationsRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  // -------------------------------------------------------------------------
  // Operations: backup (backup.run / backup.download)
  // -------------------------------------------------------------------------

  /**
   * FR-107 (extension, ADR 0005). Admin-triggered backup.
   *
   * Rate limited hard: a backup is expensive and repeated backups are the shape
   * of a slow exfiltration. Step-up is applied by the guard because both
   * capabilities are in STEP_UP_CAPABILITIES.
   */
  app.post(
    '/api/admin/backups',
    {
      config: {
        ...requires('backup.run'),
        rateLimit: { max: 3, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const manifest = await createBackup(db, config, principal, request);
      return reply.status(201).send(manifest);
    },
  );

  /**
   * Runtime self-test (row 14). GET because it changes nothing — which is what
   * makes it safe to run against production on a schedule, and a verification
   * you dare not run is not a verification.
   *
   * Audited even though it is a read: "someone verified the system on this
   * date, and this was the answer" is exactly the kind of fact an auditor asks
   * for and nobody can reconstruct afterwards.
   */
  app.get(
    '/api/admin/self-test',
    {
      config: {
        ...requires('selftest.run'),
        // Each run does real work across every table. Bounded so it cannot
        // become a denial-of-service against the database.
        rateLimit: { max: 6, timeWindow: '5 minutes' },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const report = await runSelfTest(db, config);

      await writeAudit(db, {
        actor: principal,
        action: report.healthy ? 'selftest.pass' : 'selftest.fail',
        targetType: 'system',
        targetId: null,
        detail:
          `Self-test: ${report.summary.pass} passed, ${report.summary.fail} failed, ` +
          `${report.summary.warn} warnings, ${report.summary.skipped} skipped` +
          (report.summary.fail > 0
            ? ` — ${report.checks.filter((c) => c.status === 'fail').map((c) => c.id).join(', ')}`
            : ''),
        kind: 'governance',
        request,
      });

      return report;
    },
  );

  app.get('/api/admin/backups', { config: requires('backup.run') }, async () => ({
    backups: await listBackups(db),
    // The client shows this rather than offering a button that cannot work.
    configured: Boolean(config.BACKUP_ENCRYPTION_KEY),
  }));

  /**
   * CMP-107: verify that an archive can actually be read back.
   *
   * Writes nothing — it decrypts, parses and reconciles against the manifest.
   * Safe to run against production on a schedule, which is what turns "we have
   * a restore path" into a claim with evidence behind it. The destructive half
   * lives in `tools/restore.ts` and is not reachable from the API at all.
   */
  app.post(
    '/api/admin/backups/:backupId/verify',
    {
      config: {
        ...requires('backup.run'),
        rateLimit: { max: 10, timeWindow: '10 minutes' },
      },
    },
    async (request) => {
      const { backupId } = parse(z.object({ backupId: schemas.uuid }), request.params);
      const principal = principalOf(request);

      const { manifest, contents } = await readBackup(db, config, backupId);
      const report = verifyArchive(manifest, parseArchive(contents));

      await writeAudit(db, {
        actor: principal,
        action: report.ok ? 'backup.verify.ok' : 'backup.verify.failed',
        targetType: 'backup',
        targetId: backupId,
        detail: report.ok
          ? `Verified backup ${backupId}: ${report.totalRows} rows readable, manifest reconciled`
          : `Backup ${backupId} FAILED verification: ` +
            [
              ...report.mismatches.map(
                (m) => `${m.table} manifest ${m.manifest} vs archive ${m.archive}`,
              ),
              ...report.missingTables.map((t) => `archive is missing ${t}`),
              ...report.unknownTables.map((t) => `archive carries unknown ${t}`),
            ].join('; '),
        kind: 'governance',
        request,
      });

      return report;
    },
  );

  /**
   * Download. Decrypted in-process for an authorised admin and streamed as an
   * attachment; the archive on disk stays encrypted. Integrity is verified
   * before a single byte is returned.
   */
  app.get(
    '/api/admin/backups/:backupId/download',
    {
      config: {
        ...requires('backup.download'),
        rateLimit: { max: 5, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      const { backupId } = parse(z.object({ backupId: schemas.uuid }), request.params);
      const principal = principalOf(request);

      const { manifest, contents } = await readBackup(db, config, backupId);

      await writeAudit(db, {
        actor: principal,
        action: 'backup.download',
        targetType: 'backup',
        targetId: backupId,
        detail: `Downloaded backup ${backupId} (${manifest.byteSize} bytes encrypted at rest)`,
        kind: 'governance',
        request,
      });

      return reply
        .header('Content-Type', 'application/x-ndjson')
        // SEC-033: fixed, non-reflected filename, served as an attachment.
        .header('Content-Disposition', `attachment; filename="spendifre-backup-${backupId}.jsonl"`)
        .header('X-Content-Type-Options', 'nosniff')
        .send(contents);
    },
  );
}

/**
 * Admin operations: trigger a backup, review backup history, export the
 * consolidation (ADR 0005).
 *
 * Both actions are step-up capabilities server-side, so a session whose primary
 * authentication has gone stale gets a `step_up_required` response. The view
 * says so plainly and offers the sign-in link rather than showing a generic
 * failure — a re-authentication prompt is only useful if the user understands
 * why it appeared.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { formatDateTime } from '../format.ts';
import { Status } from './Status.tsx';

interface BackupManifest {
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

function formatBytes(bytes: string): string {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return bytes;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const totalRows = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

export function OperationsView(): JSX.Element {
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);

  const reload = () =>
    api
      .get<{ backups: BackupManifest[]; configured: boolean }>('/api/admin/backups')
      .then((d) => {
        setBackups(d.backups);
        setConfigured(d.configured);
      })
      .catch(() => setBackups([]));

  useEffect(() => {
    void reload();
  }, []);

  const handle = (error: unknown) => {
    if (error instanceof ApiError && error.code === 'step_up_required') {
      setNeedsReauth(true);
      setMessage(null);
      return;
    }
    setMessage(error instanceof ApiError ? error.message : 'The operation failed.');
  };

  const runBackup = async () => {
    setBusy(true);
    setMessage(null);
    setNeedsReauth(false);
    try {
      const manifest = await api.post<BackupManifest>('/api/admin/backups');
      setMessage(
        `Backup complete — ${totalRows(manifest.rowCounts)} rows, ${formatBytes(manifest.byteSize)} encrypted.`,
      );
      await reload();
    } catch (error) {
      handle(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {needsReauth ? (
        <div className="banner banner-warn">
          <span aria-hidden="true">!</span>
          <span>
            This action needs a fresh sign-in. Backups and exports move the whole
            dataset, so re-authentication is required if your session has been open
            a while (ZT-007). <a href="/auth/login">Sign in again</a> and retry.
          </span>
        </div>
      ) : null}

      {message ? <p className="banner banner-info">{message}</p> : null}

      {!configured ? (
        <div className="banner banner-warn">
          <span aria-hidden="true">!</span>
          <span>
            Backups are not configured on this deployment. Set{' '}
            <code>BACKUP_ENCRYPTION_KEY</code> — the archive is encrypted at rest,
            so a deployment without a key refuses to create one rather than writing
            plaintext.
          </span>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h2>Operations</h2>
        </div>
        <div className="panel-body">
          <p>
            A backup captures every table except live sessions, encrypted with
            AES-256-GCM. Each one records whether the audit hash chain verified at
            the moment it was taken, so a restore can be trusted or questioned on
            evidence rather than assumption.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button button-primary"
              onClick={runBackup}
              disabled={busy || !configured}
            >
              {busy ? 'Backing up…' : 'Run backup now'}
            </button>

            {/* A plain link, not fetch(): the browser handles the download and
                the Content-Disposition header, and the session cookie rides
                along the same way it does for any navigation. */}
            <a className="button" href="/api/reports/export.xlsx">
              Export consolidation (XLSX)
            </a>
          </div>
          <p className="currency-code">
            Both actions are recorded in the audit trail with their row counts.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Backup history</h2>
        </div>
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>
              Retained for 24 months by the retention policy, like any other
              dataset. The integrity column is the audit chain state captured at
              backup time, not a check of the archive itself.
            </caption>
            <thead>
              <tr>
                <th scope="col">Taken</th>
                <th scope="col">By</th>
                <th scope="col">Region</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Rows</th>
                <th scope="col" className="num">Size</th>
                <th scope="col">Audit chain</th>
                <th scope="col">Download</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <th scope="row" className="currency-code">{formatDateTime(b.createdAt)}</th>
                  <td>{b.createdBy}</td>
                  <td className="currency-code">{b.region.toUpperCase()}</td>
                  <td>
                    {b.status === 'complete'
                      ? <Status tone="ok">Complete</Status>
                      : <Status tone="bad">Failed</Status>}
                  </td>
                  <td className="num">{totalRows(b.rowCounts) || '—'}</td>
                  <td className="num">{formatBytes(b.byteSize)}</td>
                  <td>
                    {b.auditChainIntact === true ? <Status tone="ok">Intact</Status> : null}
                    {b.auditChainIntact === false ? <Status tone="bad">Broken</Status> : null}
                    {b.auditChainIntact === null ? <Status tone="neutral">Not recorded</Status> : null}
                  </td>
                  <td>
                    {b.status === 'complete' ? (
                      <a className="button" href={`/api/admin/backups/${b.id}/download`}>
                        Download
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {backups.length === 0 ? <p className="empty">No backups taken yet.</p> : null}
        </div>
      </section>
    </>
  );
}

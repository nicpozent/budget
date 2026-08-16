/**
 * Line detail drawer (FR-012, FR-021).
 *
 * Exposes every template field, including the ones hidden from the grid, plus
 * phasing, justification and the comment thread. It is a labelled
 * `complementary` region with a close control that returns focus to the grid,
 * so keyboard users are not stranded inside it.
 */

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { CostCentre } from '../types.ts';
import { PERIOD_LABELS, formatDateTime, formatMoney } from '../format.ts';
import { CostCentreChip, Status } from './Status.tsx';
import { t } from '../i18n.ts';

interface LineDetail {
  line: {
    id: string;
    entityId: string;
    name: string;
    vendor: string | null;
    costCentreId: string | null;
    costCentreCode: string | null;
    costCentreStatus: string | null;
    glAccount: string | null;
    costType: string;
    currency: string;
    justification: string | null;
    driverKey: string | null;
    driverRatePerUnit: string | null;
    driverValue: number | null;
    assetLifeYears: number | null;
    assetLifeStatus: string | null;
    version: number;
    periodsLocal: string[];
    totalLocal: string;
    totalEur: string;
    actuals: Record<number, string>;
  };
  comments: { id: string; body: string; createdAt: string; author: string }[];
}

export function LineDrawer({
  lineId,
  costCentres,
  canEdit,
  onClose,
  onChanged,
}: {
  lineId: string;
  costCentres: CostCentre[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<LineDetail | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = () =>
    api
      .get<LineDetail>(`/api/lines/${lineId}`)
      .then(setDetail)
      .catch((e: ApiError) => setError(e.message));

  useEffect(() => {
    void load();
    closeRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId]);

  // Escape closes the drawer, which is the behaviour a keyboard user expects
  // from anything that overlays the primary content.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async (patch: Record<string, unknown>) => {
    if (!detail) return;
    try {
      await api.patch(`/api/lines/${lineId}`, { ...patch, version: detail.line.version });
      setError(null);
      await load();
      onChanged();
    } catch (e) {
      // NFR-005: a conflict is reported, not silently resolved by overwriting.
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    try {
      await api.post(`/api/lines/${lineId}/comments`, { body: comment });
      setComment('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the comment.');
    }
  };

  if (!detail) {
    return (
      <aside className="drawer" aria-label="Line detail">
        <p className="empty">{error ?? 'Loading…'}</p>
      </aside>
    );
  }

  const { line } = detail;
  const labels = PERIOD_LABELS(line.periodsLocal.length);
  const approvedCentres = costCentres.filter((c) => c.status === 'approved');

  return (
    <aside className="drawer" aria-label={`Detail for ${line.name}`}>
      <div className="drawer-header">
        <h2>{line.name}</h2>
        <button
          ref={closeRef}
          type="button"
          className="button"
          onClick={onClose}
          aria-label="Close line detail"
        >
          ✕
        </button>
      </div>

      {error ? <p className="banner banner-error">{error}</p> : null}

      <dl>
        <div className="field">
          <label htmlFor="drawer-vendor">{t('drawer.vendor')}</label>
          <input
            id="drawer-vendor"
            className="input"
            defaultValue={line.vendor ?? ''}
            disabled={!canEdit}
            onBlur={(e) => {
              if (e.target.value !== (line.vendor ?? '')) save({ vendor: e.target.value || null });
            }}
          />
        </div>

        <div className="field">
          <label htmlFor="drawer-centre">{t('drawer.costCentre')}</label>
          {/* FR-013: a constrained choice over approved centres only. A stale
              reference is still shown above, flagged, rather than cleared. */}
          <select
            id="drawer-centre"
            className="select"
            defaultValue={line.costCentreId ?? ''}
            disabled={!canEdit}
            onChange={(e) => save({ costCentreId: e.target.value || null })}
          >
            <option value="">{t('drawer.notSet')}</option>
            {approvedCentres.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.description}
              </option>
            ))}
          </select>
          <CostCentreChip code={line.costCentreCode} status={line.costCentreStatus} />
        </div>

        <div className="field">
          <label htmlFor="drawer-gl">{t('drawer.glAccount')}</label>
          <input
            id="drawer-gl"
            className="input"
            defaultValue={line.glAccount ?? ''}
            disabled={!canEdit}
            onBlur={(e) => {
              if (e.target.value !== (line.glAccount ?? '')) {
                save({ glAccount: e.target.value || null });
              }
            }}
          />
        </div>

        <div className="field">
          <label htmlFor="drawer-justification">{t('drawer.justification')}</label>
          <textarea
            id="drawer-justification"
            className="input"
            rows={4}
            defaultValue={line.justification ?? ''}
            disabled={!canEdit}
            onBlur={(e) => {
              if (e.target.value !== (line.justification ?? '')) {
                save({ justification: e.target.value || null });
              }
            }}
          />
        </div>
      </dl>

      <section>
        <h3>{t('drawer.phasing')}</h3>
        <table>
          <caption>
            Amounts in {line.currency}.{' '}
            {line.driverKey
              ? 'Driver-linked, so these are computed and read-only (INV-3).'
              : null}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('drawer.period')}</th>
              <th scope="col" className="num">{t('drawer.plan')}</th>
              <th scope="col" className="num">{t('drawer.recorded')}</th>
            </tr>
          </thead>
          <tbody>
            {labels.map((label, i) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="num">
                  {formatMoney(line.periodsLocal[i] ?? '0', line.currency)}
                </td>
                <td className="num">
                  {line.actuals[i + 1]
                    ? formatMoney(line.actuals[i + 1]!, line.currency)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('drawer.total')}</th>
              <td className="num">{formatMoney(line.totalLocal, line.currency)}</td>
              <td className="num">{formatMoney(line.totalEur, 'EUR')}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      {line.costType === 'capex' ? (
        <section>
          <h3>{t('drawer.capex')}</h3>
          <p>
            Asset life {line.assetLifeYears ?? '—'} years{' '}
            {line.assetLifeStatus === 'approved' ? (
              <Status tone="ok">{t('drawer.approved')}</Status>
            ) : line.assetLifeStatus === 'rejected' ? (
              <Status tone="bad">{t('drawer.rejected')}</Status>
            ) : (
              <Status tone="pending">{t('drawer.awaitingFinanceManager')}</Status>
            )}
          </p>
        </section>
      ) : null}

      <section>
        <h3>{t('drawer.comments')}</h3>
        {detail.comments.map((c) => (
          <div className="comment" key={c.id}>
            <div className="comment-meta">
              {c.author} · {formatDateTime(c.createdAt)}
            </div>
            {/* Rendered as text by React. A justification containing markup
                round-trips intact and still renders inert (SEC-030). */}
            <div>{c.body}</div>
          </div>
        ))}
        <div className="field">
          <label htmlFor="drawer-comment">{t('drawer.addAComment')}</label>
          <textarea
            id="drawer-comment"
            className="input"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        <button type="button" className="button button-primary" onClick={addComment}>
          {t('drawer.postComment')}
        </button>
      </section>
    </aside>
  );
}

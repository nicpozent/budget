/**
 * Budget versions, scenarios and rolling forecast (FR-080).
 *
 * Two things this screen deliberately does not do.
 *
 * It does not let anyone edit figures in a scenario. Editing is the budget
 * grid's job and the grid works on the working plan; a second editable grid
 * with a version selector would be two places to type a number and one of them
 * would be wrong. A scenario is created by copying, adjusted by copying back,
 * and read here.
 *
 * It does not hide the destructive actions behind a nav item nobody can see.
 * They are shown to anyone who can read the page and refused server-side for
 * anyone without `version.manage` — the same rule the rest of the shell follows
 * (SEC-010): the navigation is presentation, the capability is the control.
 * What it does do is ask before deleting, because a delete takes every amount
 * in the scenario with it.
 */

import { useEffect, useState } from 'react';
import { api, type ApiError } from '../api.ts';
import { can } from '@spendifre/shared';
import type {
  BudgetVersionSummary, Me, VersionComparison, VersionList,
} from '../types.ts';
import { formatMoney, formatNumber } from '../format.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { TableScroll } from './TableScroll.tsx';

const KIND_LABEL: Record<BudgetVersionSummary['kind'], MessageKey> = {
  working: 'scenario.kind.working',
  baseline: 'scenario.kind.baseline',
  scenario: 'scenario.kind.scenario',
  forecast: 'scenario.kind.forecast',
};

/** A slug from a label, so the common case needs no second field. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^[^a-z]+/, '');
}

export function ScenariosView({ me }: { me: Me }): JSX.Element {
  const [list, setList] = useState<VersionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'baseline' | 'scenario' | 'forecast'>('scenario');
  const [copyFrom, setCopyFrom] = useState('working');
  /** The key being renamed, or null when the form is creating. */
  const [editing, setEditing] = useState<string | null>(null);

  const [base, setBase] = useState('working');
  const [against, setAgainst] = useState('');
  const [comparison, setComparison] = useState<VersionComparison | null>(null);

  const mayManage = can(me.user.role, 'version.manage');

  // The tick is what re-runs the fetch. An effect that awaited a reload
  // function would set state synchronously in the effect body and cascade a
  // render on every mount; bumping a counter and letting the promise settle in
  // a callback is the same pattern `useReport` uses in reports.tsx.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get<VersionList>('/api/versions')
      .then((data) => { if (!cancelled) setList(data); })
      .catch((e: ApiError) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [tick]);

  /** Run a write, then reload — every one of these changes the list. */
  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await work());
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    act(async () => {
      const key = slugify(label);
      if (!key) throw Object.assign(new Error(t('scenario.needLabel')), { status: 422 });
      const result = await api.post<{ copiedRows: number }>('/api/versions', {
        key,
        label,
        kind,
        description: description.trim() === '' ? null : description,
        copyFrom: copyFrom === '' ? null : copyFrom,
      });
      setLabel('');
      setDescription('');
      return t('scenario.created.notice')
        .replace('{label}', label)
        .replace('{rows}', formatNumber(String(result.copiedRows)));
    });

  const rebase = (version: BudgetVersionSummary) =>
    act(async () => {
      const result = await api.post<{ closedPeriods: number; rows: number }>(
        `/api/versions/${version.key}/rebase`,
      );
      return t('scenario.rebased')
        .replace('{label}', version.label)
        .replace('{periods}', String(result.closedPeriods))
        .replace('{rows}', formatNumber(String(result.rows)));
    });

  const startEdit = (version: BudgetVersionSummary) => {
    setEditing(version.key);
    setLabel(version.label);
    setDescription(version.description ?? '');
    setNotice(null);
    setError(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setLabel('');
    setDescription('');
  };

  const rename = () =>
    act(async () => {
      const key = editing!;
      await api.patch(`/api/versions/${key}`, {
        label,
        description: description.trim() === '' ? null : description,
      });
      cancelEdit();
      return t('scenario.renamed').replace('{label}', label);
    });

  const setLocked = (version: BudgetVersionSummary, locked: boolean) =>
    act(async () => {
      await api.post(`/api/versions/${version.key}/lock`, { locked });
      return t(locked ? 'scenario.locked' : 'scenario.unlocked').replace('{label}', version.label);
    });

  const remove = (version: BudgetVersionSummary) => {
    // A cascade delete of every amount in the scenario. The one place in this
    // client that asks twice, because it is the one action that destroys data
    // the user cannot get back from this screen.
    const question = t('scenario.confirmDelete')
      .replace('{label}', version.label)
      .replace('{rows}', formatNumber(String(version.amountCount)));
    if (!window.confirm(question)) return;
    void act(async () => {
      await api.delete(`/api/versions/${version.key}`);
      return t('scenario.deleted').replace('{label}', version.label);
    });
  };

  const compare = (key: string, baseKey = base) => {
    setAgainst(key);
    setComparison(null);
    api
      .get<VersionComparison>(`/api/versions/compare?base=${baseKey}&against=${key}`)
      .then(setComparison)
      .catch((e: ApiError) => setError(e.message));
  };

  if (error && !list) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!list) return <p className="empty">{t('app.loading')}</p>;

  const labelOf = (key: string): string =>
    list.versions.find((v) => v.key === key)?.label ?? key;

  // Every version is a valid source, locked ones included: copying reads, and a
  // frozen baseline is exactly the thing someone wants to branch from. An
  // earlier revision filtered this list with a predicate that was true for
  // every row it could ever see — a rule that looked like a rule and was not.

  return (
    <>
      <p className="view-intro">{t('scenario.description')}</p>

      {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
      {notice ? <p className="banner banner-info" role="status">{notice}</p> : null}

      <section className="panel">
        <div className="panel-header">
          <h2>{t('scenario.versions')}</h2>
        </div>
        <TableScroll caption={t('scenario.versionsCaption')}>
          <thead>
            <tr>
              <th scope="col">{t('scenario.label')}</th>
              <th scope="col">{t('scenario.kind')}</th>
              <th scope="col">{t('scenario.note')}</th>
              <th scope="col">{t('scenario.source')}</th>
              <th scope="col" className="num">{t('scenario.amounts')}</th>
              <th scope="col">{t('scenario.created')}</th>
              <th scope="col">{t('scenario.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {list.versions.map((v) => (
              <tr key={v.key}>
                <th scope="row">
                  {v.label}
                  {/* A non-colour cue, as everywhere else (A11Y-001). */}
                  {v.locked ? <span className="lock-cue" title={t('scenario.isLocked')}> 🔒</span> : null}
                </th>
                <td>{t(KIND_LABEL[v.kind])}</td>
                <td>{v.description ?? '—'}</td>
                <td className="currency-code">{v.copiedFrom ?? '—'}</td>
                <td className="num">{formatNumber(String(v.amountCount))}</td>
                <td>{v.createdByName ?? '—'}</td>
                <td className="button-row">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => compare(v.key)}
                    disabled={v.kind === 'working'}
                  >
                    {t('scenario.compare')}
                  </button>
                  {mayManage && v.kind === 'forecast' ? (
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => void rebase(v)}
                      disabled={busy || v.locked}
                    >
                      {t('scenario.rebase')}
                    </button>
                  ) : null}
                  {mayManage ? (
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => startEdit(v)}
                      disabled={busy}
                    >
                      {t('scenario.rename')}
                    </button>
                  ) : null}
                  {mayManage && v.kind !== 'working' ? (
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => void setLocked(v, !v.locked)}
                      disabled={busy}
                    >
                      {t(v.locked ? 'scenario.unlock' : 'scenario.lock')}
                    </button>
                  ) : null}
                  {mayManage && v.kind !== 'working' ? (
                    <button
                      type="button"
                      className="button button-small button-danger"
                      onClick={() => remove(v)}
                      disabled={busy || v.locked}
                    >
                      {t('scenario.delete')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>

      {mayManage ? (
        <section className="panel">
          <div className="panel-header">
            <h2>{editing ? t('scenario.editing').replace('{key}', editing) : t('scenario.new')}</h2>
          </div>
          <div className="filters">
            <div className="field">
              <label htmlFor="scenario-label">{t('scenario.label')}</label>
              <input
                id="scenario-label"
                className="input"
                type="text"
                value={label}
                maxLength={120}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="scenario-note">{t('scenario.note')}</label>
              <input
                id="scenario-note"
                className="input"
                type="text"
                value={description}
                maxLength={500}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {/* Neither the kind nor the source can change after creation — the
                kind because the migration-008 trigger refuses it, the source
                because a copy already happened. Disabled rather than hidden so
                the form does not reshuffle under the cursor. */}
            <div className="field">
              <label htmlFor="scenario-kind">{t('scenario.kind')}</label>
              <select
                id="scenario-kind"
                className="select"
                value={kind}
                disabled={editing !== null}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="scenario">{t('scenario.kind.scenario')}</option>
                <option value="baseline">{t('scenario.kind.baseline')}</option>
                <option value="forecast">{t('scenario.kind.forecast')}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="scenario-copy">{t('scenario.copyFrom')}</label>
              <select
                id="scenario-copy"
                className="select"
                value={copyFrom}
                disabled={editing !== null}
                onChange={(e) => setCopyFrom(e.target.value)}
              >
                <option value="">{t('scenario.copyNothing')}</option>
                {list.versions.map((v) => (
                  <option key={v.key} value={v.key}>{v.label}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="button button-primary"
              onClick={() => void (editing ? rename() : create())}
              disabled={busy || label.trim() === ''}
            >
              {t(editing ? 'scenario.save' : 'scenario.create')}
            </button>
            {editing ? (
              <button type="button" className="button" onClick={cancelEdit} disabled={busy}>
                {t('scenario.cancel')}
              </button>
            ) : null}
          </div>
          <p className="footnote">{t('scenario.newHint')}</p>
        </section>
      ) : null}

      {comparison ? (
        <section className="panel">
          <div className="panel-header">
            {/* Labels, not keys. The key is a slug for the URL and the
                column; a heading that read "cost-freeze against growth-case"
                made the reader translate it back. */}
            <h2>
              {t('scenario.comparison')
                .replace('{base}', labelOf(comparison.base))
                .replace('{against}', labelOf(comparison.against))}
            </h2>
          </div>
          <div className="filters">
            <div className="field">
              <label htmlFor="scenario-base">{t('scenario.against')}</label>
              <select
                id="scenario-base"
                className="select"
                value={base}
                onChange={(e) => { setBase(e.target.value); compare(against, e.target.value); }}
              >
                {list.versions.filter((v) => v.key !== against).map((v) => (
                  <option key={v.key} value={v.key}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>
          <TableScroll caption={t('scenario.comparisonCaption')}>
            <thead>
              <tr>
                <th scope="col">{t('scenario.category')}</th>
                <th scope="col" className="num">{labelOf(comparison.base)}</th>
                <th scope="col" className="num">{labelOf(comparison.against)}</th>
                <th scope="col" className="num">{t('scenario.delta')}</th>
              </tr>
            </thead>
            <tbody>
              {[comparison.total, ...comparison.categories].map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td className="num">{formatMoney(row.base, 'EUR', { compact: true })}</td>
                  <td className="num">{formatMoney(row.against, 'EUR', { compact: true })}</td>
                  <td className="num">
                    {/* The arrow is the non-colour cue; increases are the
                        bad direction in a cost tool, as everywhere else. */}
                    {Number(row.delta) > 0 ? '▲ ' : Number(row.delta) < 0 ? '▼ ' : ''}
                    {formatMoney(row.delta, 'EUR', { compact: true })}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        </section>
      ) : null}
    </>
  );
}

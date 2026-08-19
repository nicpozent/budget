/**
 * Approval stages (FR-051).
 *
 * The gating logic has been tested since the feature landed; what it did not
 * have was anywhere to look at it. An approval chain that exists only as rows
 * behind four HTTP endpoints is a chain nobody can check before a submission
 * hits it, and the failure it produces — a budget that will not move because
 * the stage above it requires a role nobody holds — is discovered by the person
 * least able to fix it.
 *
 * Two things shape the screen. Order is meaningful, so it is edited with
 * explicit Up and Down buttons rather than drag-and-drop: a chain of four
 * stages is not worth a pointer-only interaction (A11Y-001, WCAG 2.5.7), and
 * the reorder endpoint takes the whole list anyway. And a disabled stage is
 * shown rather than hidden, because "we turned that stage off" is exactly the
 * fact someone is looking for when they ask why an approval skipped a step.
 */

import { useEffect, useState } from 'react';
import { api, type ApiError } from '../api.ts';
import { STAGE_APPROVER_ROLES } from '@spendifre/shared';
import type { ApprovalStage } from '../types.ts';
import { formatMoney } from '../format.ts';
import { t } from '../i18n/index.ts';

interface Draft {
  name: string;
  requiredRole: string;
  minAmountEur: string;
  enabled: boolean;
}

const EMPTY: Draft = {
  name: '',
  requiredRole: STAGE_APPROVER_ROLES[0] ?? 'cfo',
  minAmountEur: '0',
  enabled: true,
};

export function StagesView({ canConfigure }: { canConfigure: boolean }): JSX.Element {
  const [stages, setStages] = useState<ApprovalStage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  /** The stage being edited, or 'new' for the creation form, or null. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ApprovalStage[]>('/api/approval-stages')
      .then((rows) => { if (!cancelled) setStages(rows); })
      .catch((e: ApiError) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [tick]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      setEditing(null);
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    setDraft(EMPTY);
    setEditing('new');
    setError(null);
    setNotice(null);
  };

  const startEdit = (stage: ApprovalStage) => {
    setDraft({
      name: stage.name,
      requiredRole: stage.requiredRole,
      minAmountEur: stage.minAmountEur,
      enabled: stage.enabled,
    });
    setEditing(stage.id);
    setError(null);
    setNotice(null);
  };

  const save = () =>
    run(async () => {
      if (editing === 'new') {
        await api.post('/api/approval-stages', draft);
        return t('stages.created').replace('{name}', draft.name);
      }
      await api.patch(`/api/approval-stages/${editing}`, draft);
      return t('stages.updated').replace('{name}', draft.name);
    });

  /**
   * Moving one stage is still a whole-list write, because positions are unique
   * per year and the endpoint refuses a partial ordering. Swapping locally and
   * sending the result keeps that rule in one place — the server's.
   */
  const move = (index: number, delta: number) => {
    const current = stages ?? [];
    const target = index + delta;
    if (target < 0 || target >= current.length) return;
    const order = current.map((s) => s.id);
    [order[index], order[target]] = [order[target]!, order[index]!];
    return run(async () => {
      await api.put('/api/approval-stages/order', { stageIds: order });
      return t('stages.reordered').replace('{name}', current[index]!.name);
    });
  };

  if (error && !stages) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!stages) return <p className="empty">{t('app.loading')}</p>;

  return (
    <>
      <p className="view-intro">{t('stages.description')}</p>

      {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
      {notice ? <p className="banner banner-info" role="status">{notice}</p> : null}
      {stages.length === 0 ? (
        // Not an error state: no stages means the single-decision path, which
        // is a legitimate configuration and not an empty screen to apologise for.
        <p className="banner banner-info" role="status">{t('stages.noneConfigured')}</p>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h2>{t('stages.title')}</h2>
          {canConfigure ? (
            <button type="button" className="button" onClick={startCreate} disabled={busy}>
              {t('stages.add')}
            </button>
          ) : null}
        </div>

        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>{t('stages.caption')}</caption>
            <thead>
              <tr>
                <th scope="col" className="num">{t('stages.order')}</th>
                <th scope="col">{t('stages.name')}</th>
                <th scope="col">{t('stages.decidedBy')}</th>
                <th scope="col" className="num">{t('stages.appliesAtOrAbove')}</th>
                <th scope="col">{t('stages.status')}</th>
                {canConfigure ? <th scope="col">{t('stages.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {stages.map((stage, index) => (
                <tr key={stage.id}>
                  <td className="num">{stage.position}</td>
                  <th scope="row">{stage.name}</th>
                  <td>{stage.requiredRole}</td>
                  <td className="num">{formatMoney(stage.minAmountEur, 'EUR')}</td>
                  <td>
                    {/* Text, not a colour or an icon alone (A11Y-001). */}
                    {stage.enabled ? t('stages.enabled') : t('stages.disabled')}
                  </td>
                  {canConfigure ? (
                    <td className="button-row">
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => startEdit(stage)}
                        disabled={busy}
                      >
                        {t('stages.edit')}
                      </button>
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => move(index, -1)}
                        disabled={busy || index === 0}
                        aria-label={t('stages.moveUpOf').replace('{name}', stage.name)}
                      >
                        {t('stages.moveUp')}
                      </button>
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => move(index, 1)}
                        disabled={busy || index === stages.length - 1}
                        aria-label={t('stages.moveDownOf').replace('{name}', stage.name)}
                      >
                        {t('stages.moveDown')}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <section className="panel">
          <div className="panel-header">
            <h2>
              {editing === 'new'
                ? t('stages.newStage')
                : t('stages.editing').replace('{name}', draft.name)}
            </h2>
          </div>

          <div className="filters">
            <div className="field">
              <label htmlFor="stage-name">{t('stages.name')}</label>
              <input
                id="stage-name"
                className="input"
                type="text"
                value={draft.name}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="stage-role">{t('stages.decidedBy')}</label>
              {/* Only roles that hold `submission.decideStage`. Offering any
                  other would offer a stage the server refuses to create, and
                  would describe an approval chain that can never complete. */}
              <select
                id="stage-role"
                className="select"
                value={draft.requiredRole}
                onChange={(e) => setDraft({ ...draft, requiredRole: e.target.value })}
              >
                {STAGE_APPROVER_ROLES.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="stage-min">{t('stages.appliesAtOrAbove')}</label>
              <input
                id="stage-min"
                className="input num"
                type="text"
                inputMode="decimal"
                value={draft.minAmountEur}
                onChange={(e) => setDraft({ ...draft, minAmountEur: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="radio" htmlFor="stage-enabled">
                <input
                  id="stage-enabled"
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                {t('stages.enabled')}
              </label>
            </div>
          </div>

          <div className="panel-body button-row">
            <button type="button" className="button button-primary" onClick={save} disabled={busy}>
              {t('stages.save')}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setEditing(null)}
              disabled={busy}
            >
              {t('stages.cancel')}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * Template versions (FR-005).
 *
 * A template version is a frozen field set. Publishing is the only way to make
 * one usable and a published version is immutable, so the whole screen is built
 * around a single distinction: exactly one version can be a draft, and only the
 * draft can be edited.
 *
 * That is stated rather than implied. The version list shows the state as a
 * word, the field editor disappears when the selected version is published, and
 * the publish button says what publishing costs — it cannot be undone, and
 * budgets already in flight keep the version they started on. An admin who
 * discovers immutability by getting a 409 has already decided to make a change
 * they now cannot make.
 */

import { useEffect, useState } from 'react';
import { api, type ApiError } from '../api.ts';
import { FIELD_TYPES } from '@spendifre/shared';
import type { TemplateField, TemplateVersion } from '../types.ts';
import { t } from '../i18n/index.ts';

interface FieldDraft {
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  visible: boolean;
  position: number;
}

export function TemplateView({ canDefine, canPublish }: {
  canDefine: boolean;
  canPublish: boolean;
}): JSX.Element {
  const [versions, setVersions] = useState<TemplateVersion[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [fields, setFields] = useState<TemplateField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<FieldDraft>({
    fieldKey: '', label: '', fieldType: 'text', required: false, visible: true, position: 0,
  });
  /** Set while the publish confirmation is open. Publishing is irreversible. */
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<TemplateVersion[]>('/api/template/versions')
      .then((rows) => {
        if (cancelled) return;
        setVersions(rows);
        // Default to the draft if there is one, because that is the version
        // anyone opening this screen came to work on.
        const preferred = rows.find((v) => v.state === 'draft') ?? rows[0];
        setSelectedId((current) => (current && rows.some((v) => v.id === current)
          ? current
          : preferred?.id ?? ''));
      })
      .catch((e: ApiError) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    api
      .get<TemplateField[]>(`/api/template/fields?versionId=${selectedId}`)
      .then((rows) => { if (!cancelled) setFields(rows); })
      .catch((e: ApiError) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [selectedId, tick]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const selected = (versions ?? []).find((v) => v.id === selectedId) ?? null;
  const isDraft = selected?.state === 'draft';
  const editable = isDraft && canDefine;

  const newDraft = () =>
    run(async () => {
      await api.post('/api/template/versions', note ? { note } : {});
      setNote('');
      return t('template.draftOpened');
    });

  const addField = () =>
    run(async () => {
      await api.post(`/api/template/versions/${selectedId}/fields`, {
        ...draft,
        position: Number(draft.position),
      });
      setAdding(false);
      setDraft({
        fieldKey: '', label: '', fieldType: 'text', required: false, visible: true, position: 0,
      });
      return t('template.fieldAdded').replace('{key}', draft.fieldKey);
    });

  const toggle = (field: TemplateField, patch: { required?: boolean; visible?: boolean }) =>
    run(async () => {
      await api.patch(`/api/template/fields/${field.id}`, patch);
      return t('template.fieldUpdated').replace('{key}', field.fieldKey);
    });

  const publish = () =>
    run(async () => {
      await api.post(`/api/template/versions/${selectedId}/publish`);
      setConfirming(false);
      return t('template.published').replace('{version}', String(selected?.version ?? ''));
    });

  if (error && !versions) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!versions) return <p className="empty">{t('app.loading')}</p>;

  const hasDraft = versions.some((v) => v.state === 'draft');

  return (
    <>
      <p className="view-intro">{t('template.description')}</p>

      {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
      {notice ? <p className="banner banner-info" role="status">{notice}</p> : null}

      <section className="panel">
        <div className="panel-header">
          <h2>{t('template.versionsTitle')}</h2>
        </div>

        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>{t('template.versionsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col" className="num">{t('template.version')}</th>
                <th scope="col">{t('template.state')}</th>
                <th scope="col">{t('template.note')}</th>
                <th scope="col" className="num">{t('template.fields')}</th>
                <th scope="col" className="num">{t('template.budgetsOnIt')}</th>
                <th scope="col">{t('template.publishedBy')}</th>
                <th scope="col">{t('template.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <th scope="row" className="num">{v.version}</th>
                  <td>{v.state === 'draft' ? t('template.draft') : t('template.publishedState')}</td>
                  <td>{v.note ?? '—'}</td>
                  <td className="num">{v.fieldCount}</td>
                  {/* FR-005's actual promise: publishing does not move budgets
                      that already started. The count is that promise, visible. */}
                  <td className="num">{v.entityCount}</td>
                  <td>{v.publishedBy ?? '—'}</td>
                  <td className="button-row">
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => { setSelectedId(v.id); setAdding(false); setConfirming(false); }}
                      disabled={busy || v.id === selectedId}
                      aria-label={t('template.openVersion').replace('{version}', String(v.version))}
                    >
                      {v.id === selectedId ? t('template.open') : t('template.openIt')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canDefine ? (
          <div className="panel-body">
            <div className="filters">
              <div className="field">
                <label htmlFor="template-note">{t('template.note')}</label>
                <input
                  id="template-note"
                  className="input"
                  type="text"
                  value={note}
                  maxLength={500}
                  disabled={hasDraft}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="button"
                onClick={newDraft}
                disabled={busy || hasDraft}
              >
                {t('template.newDraft')}
              </button>
            </div>
            {/* The server refuses a second draft; saying so here means the
                button's disabled state is explained rather than mysterious. */}
            <p className="hint">
              {hasDraft ? t('template.draftAlreadyOpen') : t('template.newDraftCopies')}
            </p>
          </div>
        ) : null}
      </section>

      {selected ? (
        <section className="panel">
          <div className="panel-header">
            <h2>{t('template.fieldsOf').replace('{version}', String(selected.version))}</h2>
            {editable ? (
              <button
                type="button"
                className="button"
                onClick={() => setAdding(true)}
                disabled={busy}
              >
                {t('template.addField')}
              </button>
            ) : null}
          </div>

          {!isDraft ? (
            <p className="banner banner-info" role="status">{t('template.publishedImmutable')}</p>
          ) : null}

          <div className="table-scroll" tabIndex={0} role="group">
            <table>
              <caption>{t('template.fieldsCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">{t('template.position')}</th>
                  <th scope="col">{t('template.key')}</th>
                  <th scope="col">{t('template.label')}</th>
                  <th scope="col">{t('template.type')}</th>
                  <th scope="col">{t('template.required')}</th>
                  <th scope="col">{t('template.visible')}</th>
                </tr>
              </thead>
              <tbody>
                {(selectedId ? fields ?? [] : []).map((f) => (
                  <tr key={f.id}>
                    <td className="num">{f.position}</td>
                    <th scope="row" className="currency-code">{f.fieldKey}</th>
                    <td>{f.label}</td>
                    <td>{f.fieldType}</td>
                    <td>
                      <label className="radio">
                        <input
                          type="checkbox"
                          checked={f.required}
                          disabled={!editable || busy}
                          onChange={(e) => toggle(f, { required: e.target.checked })}
                        />
                        <span className="visually-hidden">
                          {t('template.requiredOf').replace('{key}', f.fieldKey)}
                        </span>
                      </label>
                    </td>
                    <td>
                      <label className="radio">
                        <input
                          type="checkbox"
                          checked={f.visible}
                          disabled={!editable || busy}
                          onChange={(e) => toggle(f, { visible: e.target.checked })}
                        />
                        <span className="visually-hidden">
                          {t('template.visibleOf').replace('{key}', f.fieldKey)}
                        </span>
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {adding && editable ? (
            <div className="panel-body">
              <div className="filters">
                <div className="field">
                  <label htmlFor="field-key">{t('template.key')}</label>
                  <input
                    id="field-key"
                    className="input"
                    type="text"
                    value={draft.fieldKey}
                    maxLength={64}
                    onChange={(e) => setDraft({ ...draft, fieldKey: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="field-label">{t('template.label')}</label>
                  <input
                    id="field-label"
                    className="input"
                    type="text"
                    value={draft.label}
                    maxLength={120}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="field-type">{t('template.type')}</label>
                  <select
                    id="field-type"
                    className="select"
                    value={draft.fieldType}
                    onChange={(e) => setDraft({ ...draft, fieldType: e.target.value })}
                  >
                    {FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="field-position">{t('template.position')}</label>
                  <input
                    id="field-position"
                    className="input num"
                    type="number"
                    min={0}
                    max={999}
                    value={draft.position}
                    onChange={(e) => setDraft({ ...draft, position: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="button-row">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={addField}
                  disabled={busy}
                >
                  {t('template.save')}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => setAdding(false)}
                  disabled={busy}
                >
                  {t('template.cancel')}
                </button>
              </div>
            </div>
          ) : null}

          {isDraft && canPublish ? (
            <div className="panel-body">
              {confirming ? (
                <>
                  <p className="banner banner-warn" role="alert">
                    {t('template.publishWarning')}
                  </p>
                  <div className="button-row">
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={publish}
                      disabled={busy}
                    >
                      {t('template.publishConfirm')}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => setConfirming(false)}
                      disabled={busy}
                    >
                      {t('template.cancel')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="button-row">
                  <button
                    type="button"
                    className="button"
                    onClick={() => setConfirming(true)}
                    disabled={busy || (fields ?? []).length === 0}
                  >
                    {t('template.publish')}
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

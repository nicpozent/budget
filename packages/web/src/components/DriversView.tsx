/**
 * Driver definitions (FR-020, FR-021).
 *
 * The last of the three subsystems that had a tested API and no screen, and the
 * one that most needed one: a driver moves every line linked to it, so editing
 * one over HTTP means editing a budget without seeing what it does.
 *
 * The shape of the screen follows the shape of the rule. A driver is either
 * typed in or defined as a sum of terms, never both, so the editor is a radio
 * choice rather than two fields that can disagree — and a derived driver's
 * value is shown read-only beside its definition, because the resolver owns it.
 */

import { useEffect, useState } from 'react';
import { api, type ApiError } from '../api.ts';
import type { Driver, DriverTermInput, Entity } from '../types.ts';
import { formatNumber } from '../format.ts';
import { t } from '../i18n/index.ts';

const DRIVER_KEYS = ['headcount', 'sites', 'devices', 'stores'] as const;
type DriverKey = (typeof DRIVER_KEYS)[number];

export function DriversView({ entities }: { entities: Entity[] }): JSX.Element {
  const [entityId, setEntityId] = useState(entities[0]?.id ?? '');
  const [drivers, setDrivers] = useState<Driver[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  /** The driver being edited, or null when the editor is closed. */
  const [editing, setEditing] = useState<DriverKey | null>(null);
  const [mode, setMode] = useState<'typed' | 'derived'>('typed');
  const [unit, setUnit] = useState('');
  const [value, setValue] = useState('0');
  const [terms, setTerms] = useState<DriverTermInput[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Driver[]>('/api/drivers')
      .then((rows) => { if (!cancelled) setDrivers(rows); })
      .catch((e: ApiError) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [tick]);

  const mine = (drivers ?? []).filter((d) => d.entityId === entityId);
  const byKey = new Map(mine.map((d) => [d.driverKey, d]));

  const startEdit = (key: DriverKey) => {
    const existing = byKey.get(key);
    setEditing(key);
    setUnit(existing?.unit ?? key);
    setValue(String(existing?.value ?? 0));
    setTerms(existing?.terms ?? []);
    setMode((existing?.terms.length ?? 0) > 0 ? 'derived' : 'typed');
    setNotice(null);
    setError(null);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const payload = mode === 'derived'
        ? { entityId, driverKey: editing, unit, terms }
        : { entityId, driverKey: editing, unit, value: Number(value) };
      const result = await api.put<{ recomputed: { key: string; from: number; to: number }[] }>(
        '/api/drivers', payload,
      );
      // FR-021's blast radius, shown rather than implied: the point of a tree
      // is that one edit moves several drivers, and the person making the edit
      // is the one who should see which.
      setNotice(
        result.recomputed.length === 0
          ? t('drivers.saved').replace('{key}', editing)
          : t('drivers.savedWithTree')
              .replace('{key}', editing)
              .replace('{moved}', result.recomputed.map((m) => `${m.key} ${m.from}→${m.to}`).join(', ')),
      );
      setEditing(null);
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const setTerm = (index: number, patch: Partial<DriverTermInput>) =>
    setTerms(terms.map((term, i) => (i === index ? { ...term, ...patch } : term)));

  if (error && !drivers) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!drivers) return <p className="empty">{t('app.loading')}</p>;

  // A driver cannot be a term of itself, and offering it would be offering a
  // request the resolver refuses.
  const sourceOptions = DRIVER_KEYS.filter((k) => k !== editing);

  return (
    <>
      <p className="view-intro">{t('drivers.description')}</p>

      {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
      {notice ? <p className="banner banner-info" role="status">{notice}</p> : null}

      <section className="panel">
        <div className="panel-header">
          <h2>{t('drivers.title')}</h2>
        </div>
        <div className="filters">
          <div className="field">
            <label htmlFor="drivers-entity">{t('drivers.entity')}</label>
            <select
              id="drivers-entity"
              className="select"
              value={entityId}
              onChange={(e) => { setEntityId(e.target.value); setEditing(null); }}
            >
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.code} — {e.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>{t('drivers.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('drivers.driver')}</th>
                <th scope="col">{t('drivers.unit')}</th>
                <th scope="col" className="num">{t('drivers.value')}</th>
                <th scope="col">{t('drivers.definition')}</th>
                <th scope="col">{t('drivers.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {DRIVER_KEYS.map((key) => {
                const driver = byKey.get(key);
                const derived = (driver?.terms.length ?? 0) > 0;
                return (
                  <tr key={key}>
                    <th scope="row">{t(`drivers.key.${key}` as never)}</th>
                    <td>{driver?.unit ?? '—'}</td>
                    <td className="num">
                      {driver ? formatNumber(String(driver.value)) : '—'}
                      {/* A non-colour cue that this figure is computed and not
                          typed, as elsewhere (A11Y-001). */}
                      {derived ? (
                        <span className="lock-cue" title={t('drivers.isDerived')}> 🔒</span>
                      ) : null}
                    </td>
                    <td>
                      {derived
                        ? driver!.terms
                            .map((term) => `${term.factor} × ${term.derivedFrom}`)
                            .join('  +  ')
                        : t('drivers.typedIn')}
                    </td>
                    <td className="button-row">
                      <button
                        type="button"
                        className="button button-small"
                        onClick={() => startEdit(key)}
                        disabled={busy}
                      >
                        {t('drivers.edit')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {editing ? (
        <section className="panel">
          <div className="panel-header">
            <h2>{t('drivers.editing').replace('{key}', editing)}</h2>
          </div>

          <fieldset className="filters">
            <legend>{t('drivers.how')}</legend>
            <label className="radio">
              <input
                type="radio"
                name="drivers-mode"
                value="typed"
                checked={mode === 'typed'}
                onChange={() => setMode('typed')}
              />
              {t('drivers.modeTyped')}
            </label>
            <label className="radio">
              <input
                type="radio"
                name="drivers-mode"
                value="derived"
                checked={mode === 'derived'}
                onChange={() => {
                  setMode('derived');
                  if (terms.length === 0) {
                    setTerms([{ derivedFrom: sourceOptions[0]!, factor: '1' }]);
                  }
                }}
              />
              {t('drivers.modeDerived')}
            </label>
          </fieldset>

          <div className="filters">
            <div className="field">
              <label htmlFor="drivers-unit">{t('drivers.unit')}</label>
              <input
                id="drivers-unit"
                className="input"
                type="text"
                value={unit}
                maxLength={40}
                onChange={(e) => setUnit(e.target.value)}
              />
            </div>
            {mode === 'typed' ? (
              <div className="field">
                <label htmlFor="drivers-value">{t('drivers.value')}</label>
                <input
                  id="drivers-value"
                  className="input num"
                  type="number"
                  min={0}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
            ) : null}
          </div>

          {mode === 'derived' ? (
            <div className="table-scroll" tabIndex={0} role="group">
              <table>
                <caption>{t('drivers.termsCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('drivers.factor')}</th>
                    <th scope="col">{t('drivers.perSource')}</th>
                    <th scope="col">{t('drivers.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {terms.map((term, index) => (
                    <tr key={term.derivedFrom}>
                      <td>
                        <label className="visually-hidden" htmlFor={`factor-${index}`}>
                          {t('drivers.factor')}
                        </label>
                        <input
                          id={`factor-${index}`}
                          className="input num"
                          type="text"
                          inputMode="decimal"
                          value={term.factor}
                          onChange={(e) => setTerm(index, { factor: e.target.value })}
                        />
                      </td>
                      <td>
                        <label className="visually-hidden" htmlFor={`source-${index}`}>
                          {t('drivers.perSource')}
                        </label>
                        <select
                          id={`source-${index}`}
                          className="select"
                          value={term.derivedFrom}
                          onChange={(e) => setTerm(index, { derivedFrom: e.target.value })}
                        >
                          {sourceOptions.map((k) => (
                            <option key={k} value={k}>{t(`drivers.key.${k}` as never)}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button button-small button-danger"
                          onClick={() => setTerms(terms.filter((_, i) => i !== index))}
                        >
                          {t('drivers.removeTerm')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="button-row">
            {mode === 'derived' ? (
              <button
                type="button"
                className="button"
                disabled={busy || terms.length >= sourceOptions.length}
                onClick={() => {
                  const used = new Set(terms.map((term) => term.derivedFrom));
                  const next = sourceOptions.find((k) => !used.has(k));
                  if (next) setTerms([...terms, { derivedFrom: next, factor: '1' }]);
                }}
              >
                {t('drivers.addTerm')}
              </button>
            ) : null}
            <button
              type="button"
              className="button button-primary"
              onClick={() => void save()}
              disabled={busy || (mode === 'derived' && terms.length === 0)}
            >
              {t('drivers.save')}
            </button>
            <button type="button" className="button" onClick={() => setEditing(null)} disabled={busy}>
              {t('drivers.cancel')}
            </button>
          </div>
          <p className="footnote">{t('drivers.hint')}</p>
        </section>
      ) : null}
    </>
  );
}

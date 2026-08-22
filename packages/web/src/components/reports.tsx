/**
 * Trend (FR-061), FX history (FR-063) and allocations (FR-023).
 *
 * These three had tested endpoints and no screen. Each is a read-only report,
 * so they share a file rather than one each.
 *
 * Charts follow the same rule as the rest of the client: SVG bars with a text
 * label and the value beside them. The CSP has no `unsafe-inline`, which blocks
 * the `style` attribute React would need for a percentage-width div, and a
 * canvas chart would carry meaning no screen reader can reach.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { ApiError } from '../api.ts';
import type { Allocations, Entity, FxHistory, Trend } from '../types.ts';
import { formatMoney, formatNumber } from '../format.ts';
import { t } from '../i18n/index.ts';
import { BarTrack } from './Bar.tsx';
import { TableScroll } from './TableScroll.tsx';

/**
 * Fetch a report, keyed by URL.
 *
 * The result carries the URL it belongs to. That is what makes changing a
 * filter show a loading state rather than the previous filter's figures under
 * the new heading — and it does so without clearing state inside the effect,
 * which would cascade a render on every mount.
 */
function useReport<T>(url: string): { data: T | null; error: string | null } {
  const [result, setResult] = useState<{ url: string; data: T | null; error: string | null }>(
    { url: '', data: null, error: null },
  );

  useEffect(() => {
    let cancelled = false;
    api
      .get<T>(url)
      .then((data) => { if (!cancelled) setResult({ url, data, error: null }); })
      .catch((e: ApiError) => { if (!cancelled) setResult({ url, data: null, error: e.message }); });
    // The flag stops a slow response for a filter the user has already changed
    // from overwriting a fast response for the one they are looking at.
    return () => { cancelled = true; };
  }, [url]);

  if (result.url !== url) return { data: null, error: null };
  return { data: result.data, error: result.error };
}

// ---------------------------------------------------------------------------
// FR-061 Trend
// ---------------------------------------------------------------------------

export function TrendView({ entities, fiscalYear }: {
  entities: Entity[];
  fiscalYear: number;
}): JSX.Element {
  const [entityId, setEntityId] = useState('');
  const [mode, setMode] = useState<'total' | 'category' | 'line'>('total');
  const [plotted, setPlotted] = useState<string | null>(null);

  const query = new URLSearchParams({ mode });
  if (entityId) query.set('entityId', entityId);
  const { data, error } = useReport<Trend>(`/api/reports/trend?${query.toString()}`);

  // FR-061 asks for a breakdown that explodes a category into its lines, any of
  // which can be plotted. `plotted` is that selection; it is cleared whenever
  // the mode changes, because the ids are not comparable across modes.
  const series = useMemo(() => {
    if (!data) return [];
    return [...data.series]
      .sort((a, b) => Number(b.values[fiscalYear] ?? 0) - Number(a.values[fiscalYear] ?? 0))
      .slice(0, mode === 'line' ? 15 : 50);
  }, [data, fiscalYear, mode]);

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!data) return <p className="empty">{t('app.loading')}</p>;

  const totals = data.years.map((y) => Number(data.total[y] ?? 0));
  const maxTotal = Math.max(...totals, 0);
  const plottedSeries = plotted ? series.find((s) => s.id === plotted) : null;
  const maxPlotted = plottedSeries
    ? Math.max(...data.years.map((y) => Number(plottedSeries.values[y] ?? 0)), 0)
    : 0;

  return (
    <>
      <p className="view-intro">{t('trend.description', { year: fiscalYear })}</p>

      <div className="filter-row">
        <div className="field">
          <label htmlFor="trend-entity">{t('budget.entity')}</label>
          <select
            id="trend-entity"
            className="select"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          >
            <option value="">{t('trend.allEntities')}</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.code} — {e.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="trend-mode">{t('trend.mode')}</label>
          <select
            id="trend-mode"
            className="select"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setPlotted(null);
            }}
          >
            <option value="total">{t('trend.mode.total')}</option>
            <option value="category">{t('trend.mode.category')}</option>
            <option value="line">{t('trend.mode.line')}</option>
          </select>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2>{plottedSeries ? t('trend.plotted', { label: plottedSeries.label }) : t('trend.total')}</h2>
        </div>
        <TableScroll
          caption={plottedSeries
            ? t('trend.captionPlotted', { label: plottedSeries.label })
            : t('trend.caption')}
        >
          <thead>
            <tr>
              <th scope="col">{t('trend.year')}</th>
              <th scope="col" className="num">{t('trend.total')}</th>
              <th scope="col">{/* bar */}</th>
              <th scope="col" className="num">{t('trend.change')}</th>
            </tr>
          </thead>
          <tbody>
            {data.years.map((year, index) => {
              const value = plottedSeries
                ? Number(plottedSeries.values[year] ?? 0)
                : Number(data.total[year] ?? 0);
              const previousYear = data.years[index - 1];
              const previous = previousYear === undefined
                ? null
                : plottedSeries
                  ? Number(plottedSeries.values[previousYear] ?? 0)
                  : Number(data.total[previousYear] ?? 0);
              const change = previous && previous !== 0
                ? ((value - previous) / previous) * 100
                : null;
              return (
                <tr key={year}>
                  <th scope="row">{year}</th>
                  <td className="num">{formatMoney(String(value), 'EUR', { compact: true })}</td>
                  <td><BarTrack value={value} max={plottedSeries ? maxPlotted : maxTotal} /></td>
                  <td className="num">
                    {change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(1)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableScroll>
      </section>

      {mode !== 'total' ? (
        <section className="panel">
          <div className="panel-header">
            <h2>{t('trend.series')}</h2>
          </div>
          <TableScroll caption={t('trend.seriesCaption')}>
            <thead>
              <tr>
                <th scope="col">{mode === 'category' ? t('nav.consolidation') : t('trend.series')}</th>
                {data.years.map((y) => (
                  <th key={y} scope="col" className="num">{y}</th>
                ))}
                <th scope="col">{/* plot control */}</th>
              </tr>
            </thead>
            <tbody>
              {series.length === 0 ? (
                <tr><td colSpan={data.years.length + 2}>{t('trend.noData')}</td></tr>
              ) : series.map((s) => (
                <tr key={s.id} aria-current={plotted === s.id ? 'true' : undefined}>
                  <th scope="row">{s.label}</th>
                  {data.years.map((y) => (
                    <td key={y} className="num">
                      {formatMoney(s.values[y] ?? '0', 'EUR', { compact: true })}
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="button"
                      aria-pressed={plotted === s.id}
                      onClick={() => setPlotted(plotted === s.id ? null : s.id)}
                    >
                      {t('trend.plot')}
                    </button>
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

// ---------------------------------------------------------------------------
// FR-063 FX history
// ---------------------------------------------------------------------------

/**
 * Spread between the highest and lowest rate on record as a share of the mean.
 *
 * A standard deviation over five annual points would imply more precision than
 * five points support; range-over-mean says the same thing without the
 * statistical claim, and it is a figure a reader can check by eye against the
 * row it summarises.
 */
function volatility(history: readonly { rate: string }[]): number | null {
  const rates = history.map((h) => Number(h.rate)).filter(Number.isFinite);
  if (rates.length < 2) return null;
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  if (mean === 0) return null;
  return ((Math.max(...rates) - Math.min(...rates)) / mean) * 100;
}

export function FxHistoryView(): JSX.Element {
  const { data, error } = useReport<FxHistory[]>('/api/reports/fx-history');

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!data) return <p className="empty">{t('app.loading')}</p>;
  if (data.length === 0) return <p className="empty">{t('fx.noData')}</p>;

  const years = [...new Set(data.flatMap((c) => c.history.map((h) => h.year)))].sort();

  return (
    <>
      <p className="view-intro">{t('fx.description')}</p>

      <section className="panel">
        <div className="panel-header">
          <h2>{t('fx.title')}</h2>
        </div>
        <TableScroll caption={t('fx.volatilityHint')}>
          <thead>
            <tr>
              <th scope="col">{t('fx.currency')}</th>
              {years.map((y) => (
                <th key={y} scope="col" className="num">{y}</th>
              ))}
              <th scope="col" className="num">{t('fx.drift')}</th>
              <th scope="col" className="num">{t('fx.volatility')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const spread = volatility(row.history);
              return (
                <tr key={row.currency}>
                  <th scope="row" className="currency-code">{row.currency}</th>
                  {years.map((y) => {
                    const point = row.history.find((h) => h.year === y);
                    return (
                      <td key={y} className="num">
                        {point ? Number(point.rate).toFixed(6) : '—'}
                      </td>
                    );
                  })}
                  <td className="num">{Number(row.drift).toFixed(6)}</td>
                  <td className="num">{spread === null ? '—' : `${spread.toFixed(1)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </TableScroll>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// FR-023 Allocations
// ---------------------------------------------------------------------------

export function AllocationsView(): JSX.Element {
  const { data, error } = useReport<Allocations>('/api/reports/allocations');

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!data) return <p className="empty">{t('app.loading')}</p>;

  const maxTotal = Math.max(...data.entities.map((e) => Number(e.total)), 0);

  return (
    <>
      <p className="view-intro">{t('alloc.description')}</p>

      <section className="panel">
        <div className="panel-header">
          <h2>{t('alloc.pools')}</h2>
        </div>
        <TableScroll caption={t('alloc.poolsCaption')}>
          <thead>
            <tr>
              <th scope="col">{t('alloc.pool')}</th>
              <th scope="col" className="num">{t('alloc.amount')}</th>
              <th scope="col">{t('alloc.driver')}</th>
            </tr>
          </thead>
          <tbody>
            {data.pools.length === 0 ? (
              <tr><td colSpan={3}>{t('alloc.noPools')}</td></tr>
            ) : data.pools.map((p) => (
              <tr key={p.name}>
                <th scope="row">{p.name}</th>
                <td className="num">{formatMoney(p.amount, p.currency)}</td>
                <td>{p.driverKey}</td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>{t('alloc.byEntity')}</h2>
        </div>
        <TableScroll caption={t('alloc.entityCaption')}>
          <thead>
            <tr>
              <th scope="col">{t('alloc.entity')}</th>
              <th scope="col" className="num">{t('alloc.own')}</th>
              <th scope="col" className="num">{t('alloc.charged')}</th>
              <th scope="col" className="num">{t('alloc.total')}</th>
              <th scope="col">{/* bar */}</th>
            </tr>
          </thead>
          <tbody>
            {data.entities.map((e) => (
              <tr key={e.id}>
                <th scope="row" className="currency-code">{e.code}</th>
                <td className="num">{formatMoney(e.own, 'EUR', { compact: true })}</td>
                <td className="num">
                  {formatMoney(e.charged, 'EUR', { compact: true })}
                  {/* INV-6: non-colour cue that the figure is not the
                      entity's to change (A11Y-001). */}
                  {e.chargedReadOnly ? (
                    <span className="lock-cue" title={t('alloc.readOnly')}> 🔒</span>
                  ) : null}
                </td>
                <td className="num">{formatMoney(e.total, 'EUR', { compact: true })}</td>
                <td><BarTrack value={Number(e.total)} max={maxTotal} /></td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>

      <p className="footnote">{formatNumber(String(data.entities.length))} entities in scope.</p>
    </>
  );
}

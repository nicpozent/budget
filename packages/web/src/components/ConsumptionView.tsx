/**
 * FR-041 / FR-042 actuals against plan, with the over-pace flag.
 */

import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { Consumption, Entity } from '../types.ts';
import { deltaClass, deltaGlyph, formatMoney, formatPercent } from '../format.ts';
import { Status } from './Status.tsx';
import { t } from '../i18n/index.ts';
import { TableScroll } from './TableScroll.tsx';

export function ConsumptionView({ entities }: { entities: Entity[] }): JSX.Element {
  const [entityId, setEntityId] = useState('');
  const [data, setData] = useState<Consumption | null>(null);

  useEffect(() => {
    const query = entityId ? `?entityId=${encodeURIComponent(entityId)}` : '';
    api.get<Consumption>(`/api/reports/consumption${query}`).then(setData).catch(() => setData(null));
  }, [entityId]);

  if (!data) return <p className="empty">{t('views.loading')}</p>;

  return (
    <>
      {/* FR-044: the filter row is hidden when the caller has one budget. */}
      {data.showFilters ? (
        <div className="filters">
          <div className="field">
            <label htmlFor="consumption-entity">{t('views.entity')}</label>
            <select
              id="consumption-entity"
              className="select"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
            >
              <option value="">{t('views.allEntitiesInScope')}</option>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.code} — {e.name}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {data.kpis ? (
        <div className="kpi-row">
          <div className="kpi">
            <div className="kpi-label">{t('views.fullyearPlan')}</div>
            <div className="kpi-value">{formatMoney(data.kpis.plan, 'EUR', { compact: true })}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('views.spendToDate')}</div>
            <div className="kpi-value">{formatMoney(data.kpis.actual, 'EUR', { compact: true })}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">
              Plan to date ({data.kpis.elapsedPeriods}/{data.kpis.totalPeriods} periods)
            </div>
            <div className="kpi-value">{formatMoney(data.kpis.ytdPlan, 'EUR', { compact: true })}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('views.variance')}</div>
            <div className={`kpi-value ${deltaClass(data.kpis.variance)}`}>
              <span aria-hidden="true">{deltaGlyph(data.kpis.variance)}</span>{' '}
              {formatMoney(data.kpis.variance, 'EUR', { compact: true })}
            </div>
          </div>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header"><h2>{t('views.consumptionByLine')}</h2></div>
        <TableScroll caption={t('views.consumptionCaption')}>
          <thead>
            <tr>
              <th scope="col">{t('views.line')}</th>
              <th scope="col">{t('views.entity')}</th>
              <th scope="col">{t('views.category')}</th>
              <th scope="col" className="num">{t('views.plan')}</th>
              <th scope="col" className="num">{t('views.spend')}</th>
              <th scope="col" className="num">{t('views.consumed')}</th>
              <th scope="col">{t('views.pace')}</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.slice(0, 200).map((line) => (
              <tr key={line.id}>
                <th scope="row">{line.name}</th>
                <td className="currency-code">{line.entityCode}</td>
                <td>{line.categoryName}</td>
                <td className="num">{formatMoney(line.plan, 'EUR', { compact: true })}</td>
                <td className="num">{formatMoney(line.actual, 'EUR', { compact: true })}</td>
                <td className="num">{formatPercent(line.actual, line.plan)}</td>
                <td>
                  {line.overPace
                    ? <Status tone="bad">{t('views.overPace')}</Status>
                    : <Status tone="ok">{t('views.onPace')}</Status>}
                </td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>
    </>
  );
}

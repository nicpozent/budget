/**
 * FR-062 variance against the prior year, largest movements first.
 */

import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { Entity, Variance } from '../types.ts';
import { deltaClass, deltaGlyph, formatMoney } from '../format.ts';
import { t } from '../i18n/index.ts';
import { TableScroll } from './TableScroll.tsx';

export function VarianceView({ entities }: { entities: Entity[] }): JSX.Element {
  const [entityId, setEntityId] = useState('');
  const [data, setData] = useState<Variance | null>(null);

  useEffect(() => {
    const query = entityId ? `?entityId=${encodeURIComponent(entityId)}` : '';
    api.get<Variance>(`/api/reports/variance${query}`).then(setData).catch(() => setData(null));
  }, [entityId]);

  if (!data) return <p className="empty">{t('views.loading')}</p>;

  return (
    <>
      <div className="filters">
        <div className="field">
          <label htmlFor="variance-entity">{t('views.entity')}</label>
          <select
            id="variance-entity"
            className="select"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          >
            <option value="">{t('views.allEntitiesInScope')}</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.code}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="banner banner-info" role="status">
        <span aria-hidden="true">▲</span>
        <span>
          This is a cost tool, so growth is the unwanted direction: increases are shown in the
          danger colour with an up arrow, reductions in the accent colour with a down arrow.
        </span>
      </div>

      <section className="panel">
        <div className="panel-header"><h2>{t('views.largestMovements')}</h2></div>
        <TableScroll caption={t('views.largestMovementsCaption')}>
          <thead>
            <tr>
              <th scope="col">{t('views.line')}</th>
              <th scope="col">{t('views.entity')}</th>
              <th scope="col">{t('views.category')}</th>
              <th scope="col" className="num">{t('views.priorYear')}</th>
              <th scope="col" className="num">{t('views.thisYear')}</th>
              <th scope="col" className="num">{t('views.movement')}</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.slice(0, 60).map((line) => (
              <tr key={line.id}>
                <th scope="row">{line.name}</th>
                <td className="currency-code">{line.entityCode}</td>
                <td>{line.categoryName}</td>
                <td className="num">{formatMoney(line.prior, 'EUR', { compact: true })}</td>
                <td className="num">{formatMoney(line.current, 'EUR', { compact: true })}</td>
                <td className={`num ${deltaClass(line.delta)}`}>
                  <span aria-hidden="true">{deltaGlyph(line.delta)}</span>{' '}
                  {formatMoney(line.delta, 'EUR', { compact: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>
    </>
  );
}

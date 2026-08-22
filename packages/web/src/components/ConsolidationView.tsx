/**
 * FR-060 group consolidation: the whole-group total, the category split,
 * spend by country, and every entity's submission state.
 */

import { useEffect, useState } from 'react';
import type { ApiError } from '../api.ts';
import { api } from '../api.ts';
import type { Consolidation } from '../types.ts';
import { formatMoney, formatPercent } from '../format.ts';
import { BudgetStateChip } from './Status.tsx';
import { t } from '../i18n/index.ts';
import { BarRow } from './Bar.tsx';
import { TableScroll } from './TableScroll.tsx';

export function ConsolidationView(): JSX.Element {
  const [data, setData] = useState<Consolidation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Consolidation>('/api/reports/consolidation')
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!data) return <p className="empty">{t('views.loading')}</p>;

  const maxCategory = Math.max(...data.categories.map((c) => Number(c.plan)), 0);

  return (
    <>
      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">{t('views.groupTotalEur')}</div>
          <div className="kpi-value">{formatMoney(data.total, 'EUR', { compact: true })}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('views.recordedSpend')}</div>
          <div className="kpi-value">{formatMoney(data.actual, 'EUR', { compact: true })}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('views.consumed')}</div>
          <div className="kpi-value">{formatPercent(data.actual, data.total)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('views.entitiesInScope')}</div>
          <div className="kpi-value">{data.entities.length}</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2>{t('views.categorySplit')}</h2>
        </div>
        <div className="panel-body bar-chart">
          {data.categories.map((c) => (
            <BarRow key={c.id} label={c.name} value={c.plan} max={maxCategory} />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>{t('views.spendByCountry')}</h2>
        </div>
        <TableScroll caption={t('views.everyEntityIsInOneCountry')}>
          <thead>
            <tr>
              <th scope="col">{t('views.country')}</th>
              <th scope="col" className="num">{t('views.planEur')}</th>
              <th scope="col" className="num">{t('views.spend')}</th>
              <th scope="col" className="num">{t('views.consumed')}</th>
            </tr>
          </thead>
          <tbody>
            {data.countries.map((c) => (
              <tr key={c.code}>
                <th scope="row">{c.name}</th>
                <td className="num">{formatMoney(c.plan, 'EUR', { compact: true })}</td>
                <td className="num">{formatMoney(c.actual, 'EUR', { compact: true })}</td>
                <td className="num">{formatPercent(c.actual, c.plan)}</td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>{t('views.submissionStatusByEntity')}</h2>
        </div>
        <TableScroll caption={t('views.everyFigureIsTheSumOfThatEntitysLines')}>
          <thead>
            <tr>
              <th scope="col">{t('views.entity')}</th>
              <th scope="col">{t('views.name')}</th>
              <th scope="col">{t('views.state')}</th>
              <th scope="col" className="num">{t('views.planEur')}</th>
              <th scope="col" className="num">{t('views.spend')}</th>
            </tr>
          </thead>
          <tbody>
            {data.entities.map((e) => (
              <tr key={e.id}>
                <th scope="row" className="currency-code">{e.code}</th>
                <td>{e.name}</td>
                <td><BudgetStateChip state={e.state} /></td>
                <td className="num">{formatMoney(e.plan, 'EUR', { compact: true })}</td>
                <td className="num">{formatMoney(e.actual, 'EUR', { compact: true })}</td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>
    </>
  );
}

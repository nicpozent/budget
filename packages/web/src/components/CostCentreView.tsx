/**
 * FR-013 the cost-centre registry and its approvals (SEC-012).
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { CostCentre } from '../types.ts';
import { Status } from './Status.tsx';
import { t } from '../i18n/index.ts';
import { TableScroll } from './TableScroll.tsx';

export function CostCentreView({ canApprove }: { canApprove: boolean }): JSX.Element {
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const reload = () => api.get<CostCentre[]>('/api/cost-centres').then(setCentres).catch(() => setCentres([]));
  useEffect(() => {
    void reload();
  }, []);

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await api.post(`/api/cost-centres/${id}/decision`, { decision });
      setMessage(null);
      await reload();
    } catch (e) {
      // SEC-012 surfaces here: the creator cannot approve their own centre.
      setMessage(e instanceof ApiError ? e.message : 'Could not record the decision.');
    }
  };

  return (
    <>
      {message ? <p className="banner banner-error" role="alert">{message}</p> : null}
      <section className="panel">
        <div className="panel-header"><h2>{t('views.costCentreRegistry')}</h2></div>
        <TableScroll caption={t('views.managersMayOnlyBookLinesToApprovedCentre')}>
          <thead>
            <tr>
              <th scope="col">{t('views.code')}</th>
              <th scope="col">{t('views.description')}</th>
              <th scope="col">{t('views.status')}</th>
              {canApprove ? <th scope="col">{t('views.decision')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {centres.map((c) => (
              <tr key={c.id}>
                <th scope="row" className="currency-code">{c.code}</th>
                <td>{c.description}</td>
                <td>
                  {c.status === 'approved' ? <Status tone="ok">{t('views.approved')}</Status> : null}
                  {c.status === 'pending' ? <Status tone="pending">{t('views.pending')}</Status> : null}
                  {c.status === 'rejected' ? <Status tone="bad">{t('views.rejected')}</Status> : null}
                </td>
                {canApprove ? (
                  <td>
                    <div className="button-row">
                      <button type="button" className="button" onClick={() => decide(c.id, 'approved')}>
                        {t('views.approve')}
                      </button>
                      <button type="button" className="button button-danger" onClick={() => decide(c.id, 'rejected')}>
                        {t('views.reject')}
                      </button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>
    </>
  );
}

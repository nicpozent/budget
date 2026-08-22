/**
 * SPEC §9 data governance: classifications, retention, and the subject
 * requests behind them.
 */

import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Status } from './Status.tsx';
import { t } from '../i18n/index.ts';
import { TableScroll } from './TableScroll.tsx';

export function GovernanceView(): JSX.Element {
  const [classifications, setClassifications] = useState<{ fieldKey: string; dataClass: string }[]>([]);
  const [retention, setRetention] = useState<{ dataset: string; months: number }[]>([]);
  const [integrity, setIntegrity] = useState<{ intact: boolean; firstBadSeq: string | null } | null>(null);

  useEffect(() => {
    api.get<typeof classifications>('/api/governance/classifications').then(setClassifications).catch(() => undefined);
    api.get<typeof retention>('/api/governance/retention').then(setRetention).catch(() => undefined);
    api
      .get<{ intact: boolean; firstBadSeq: string | null }>('/api/governance/audit-integrity')
      .then(setIntegrity)
      .catch(() => undefined);
  }, []);

  return (
    <>
      {integrity ? (
        <div
        className={`banner ${integrity.intact ? 'banner-info' : 'banner-error'}`}
        // WCAG 4.1.3. A broken audit chain is the one banner in the product
        // that must interrupt.
        role={integrity.intact ? 'status' : 'alert'}
      >
          <span aria-hidden="true">{integrity.intact ? '✓' : '✕'}</span>
          <span>
            {integrity.intact
              ? 'Audit hash chain verified end to end — no entry has been altered or removed.'
              : `Audit chain broken at sequence ${integrity.firstBadSeq}. Investigate immediately.`}
          </span>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header"><h2>{t('views.fieldClassification')}</h2></div>
        <TableScroll caption={t('views.everyFieldCarriesExactlyOneClassificatio')}>
          <thead>
            <tr><th scope="col">{t('views.field')}</th><th scope="col">{t('views.class')}</th></tr>
          </thead>
          <tbody>
            {classifications.map((c) => (
              <tr key={c.fieldKey}>
                <th scope="row" className="currency-code">{c.fieldKey}</th>
                <td>
                  {c.dataClass === 'personal_data' ? (
                    <Status tone="pending">{t('views.personalData')}</Status>
                  ) : c.dataClass === 'confidential' ? (
                    <Status tone="bad">{t('views.confidential')}</Status>
                  ) : (
                    <Status tone="neutral">{c.dataClass}</Status>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>

      <section className="panel">
        <div className="panel-header"><h2>{t('views.retention')}</h2></div>
        <TableScroll caption={t('views.enforcedByAScheduledJobThatWritesAnAudit')}>
          <thead>
            <tr><th scope="col">{t('views.dataset')}</th><th scope="col" className="num">{t('views.months')}</th></tr>
          </thead>
          <tbody>
            {retention.map((r) => (
              <tr key={r.dataset}>
                <th scope="row">{r.dataset}</th>
                <td className="num">{r.months}</td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      </section>
    </>
  );
}

/**
 * FR-070..FR-073 the audit trail, scoped server-side to what the caller
 * may see.
 */

import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { AuditEvent } from '../types.ts';
import { formatDateTime } from '../format.ts';
import { t } from '../i18n/index.ts';
import { TableScroll } from './TableScroll.tsx';

export function AuditView(): JSX.Element {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [scope, setScope] = useState<'all' | 'own'>('own');
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (query) params.set('q', query);
    params.set('limit', '100');
    api
      .get<{ scope: 'all' | 'own'; events: AuditEvent[] }>(`/api/audit?${params.toString()}`)
      .then((d) => {
        setEvents(d.events);
        setScope(d.scope);
      })
      .catch(() => setEvents([]));
  }, [kind, query]);

  return (
    <>
      {/* FR-071: managers see only their own events. Saying so is honest and
          stops a manager reading an empty list as a bug. */}
      <div className="banner banner-info" role="status">
        <span aria-hidden="true">ⓘ</span>
        <span>
          {scope === 'all'
            ? 'Showing every action across all entities and roles.'
            : 'Showing your own actions only. This is enforced in the query, not hidden in the page.'}
        </span>
      </div>

      <div className="filters">
        <div className="field">
          <label htmlFor="audit-kind">{t('views.kind')}</label>
          <select id="audit-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t('views.allKinds')}</option>
            <option value="change">{t('views.change')}</option>
            <option value="approval">{t('views.approval')}</option>
            <option value="workflow">{t('views.workflow')}</option>
            <option value="governance">{t('views.governance')}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-search">{t('views.search')}</label>
          <input
            id="audit-search"
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('audit.searchPlaceholder')}
          />
        </div>
      </div>

      <section className="panel">
        <TableScroll caption={t('views.appendonlyEntriesCannotBeEditedOrDeleted')}>
          <thead>
            <tr>
              <th scope="col">{t('views.when')}</th>
              <th scope="col">{t('views.actor')}</th>
              <th scope="col">{t('views.role')}</th>
              <th scope="col">{t('views.action')}</th>
              <th scope="col">{t('views.detail')}</th>
              <th scope="col">{t('views.kind')}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="currency-code">{formatDateTime(e.occurred_at)}</td>
                <td>{e.actor_name}</td>
                <td className="currency-code">{e.actor_role}</td>
                <th scope="row" className="currency-code">{e.action}</th>
                <td>{e.detail}</td>
                <td>{e.kind}</td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
        {events.length === 0 ? <p className="empty">{t('views.noMatchingEvents')}</p> : null}
      </section>
    </>
  );
}

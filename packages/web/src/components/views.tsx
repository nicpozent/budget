/**
 * The reporting and administration views.
 *
 * Charts are drawn as labelled bars in the DOM rather than in a canvas: a bar
 * with a text label and a numeric value is readable by a screen reader and
 * survives a strict CSP without a charting library in the trust boundary
 * (SEC-032, SEC-040). Colour is never the only carrier of meaning.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type {
  AuditEvent,
  Consolidation,
  Consumption,
  CostCentre,
  Entity,
  RuleViolation,
  Submission,
  Variance,
} from '../types.ts';
import {
  deltaClass,
  deltaGlyph,
  formatDateTime,
  formatMoney,
  formatPercent,
} from '../format.ts';
import { BudgetStateChip, Status } from './Status.tsx';

/**
 * A labelled horizontal bar.
 *
 * Drawn as SVG rather than a div with a percentage width, because SEC-032's CSP
 * has no `unsafe-inline` and that blocks inline `style` attributes as well as
 * inline `<style>` blocks — a React `style={{ width }}` prop would simply not
 * render. SVG's `width` is a presentational attribute, not CSS, so it is
 * unaffected. The bar is `aria-hidden`; the value beside it is the real content.
 */
function Bar({ label, value, max, currency = 'EUR' }: {
  label: string;
  value: string;
  max: number;
  currency?: string;
}): JSX.Element {
  const numeric = Number(value);
  const pct = max > 0 && Number.isFinite(numeric) ? Math.min(100, Math.max(0, (numeric / max) * 100)) : 0;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <svg className="bar-track" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
        <rect className="bar-fill" x="0" y="0" width={pct} height="14" rx="1.5" />
      </svg>
      <span className="num">{formatMoney(value, currency, { compact: true })}</span>
    </div>
  );
}

export function ConsolidationView(): JSX.Element {
  const [data, setData] = useState<Consolidation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Consolidation>('/api/reports/consolidation')
      .then(setData)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  if (error) return <p className="banner banner-error">{error}</p>;
  if (!data) return <p className="empty">Loading…</p>;

  const maxCategory = Math.max(...data.categories.map((c) => Number(c.plan)), 0);

  return (
    <>
      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Group total (EUR)</div>
          <div className="kpi-value">{formatMoney(data.total, 'EUR', { compact: true })}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Recorded spend</div>
          <div className="kpi-value">{formatMoney(data.actual, 'EUR', { compact: true })}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Consumed</div>
          <div className="kpi-value">{formatPercent(data.actual, data.total)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Entities in scope</div>
          <div className="kpi-value">{data.entities.length}</div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2>Category split</h2>
        </div>
        <div className="panel-body bar-chart">
          {data.categories.map((c) => (
            <Bar key={c.id} label={c.name} value={c.plan} max={maxCategory} />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Submission status by entity</h2>
        </div>
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>Every figure is the sum of that entity&rsquo;s lines.</caption>
            <thead>
              <tr>
                <th scope="col">Entity</th>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col" className="num">Plan (EUR)</th>
                <th scope="col" className="num">Spend</th>
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
          </table>
        </div>
      </section>
    </>
  );
}

export function ConsumptionView({ entities }: { entities: Entity[] }): JSX.Element {
  const [entityId, setEntityId] = useState('');
  const [data, setData] = useState<Consumption | null>(null);

  useEffect(() => {
    const query = entityId ? `?entityId=${encodeURIComponent(entityId)}` : '';
    api.get<Consumption>(`/api/reports/consumption${query}`).then(setData).catch(() => setData(null));
  }, [entityId]);

  if (!data) return <p className="empty">Loading…</p>;

  return (
    <>
      {/* FR-044: the filter row is hidden when the caller has one budget. */}
      {data.showFilters ? (
        <div className="filters">
          <div className="field">
            <label htmlFor="consumption-entity">Entity</label>
            <select
              id="consumption-entity"
              className="select"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
            >
              <option value="">All entities in scope</option>
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
            <div className="kpi-label">Full-year plan</div>
            <div className="kpi-value">{formatMoney(data.kpis.plan, 'EUR', { compact: true })}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Spend to date</div>
            <div className="kpi-value">{formatMoney(data.kpis.actual, 'EUR', { compact: true })}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">
              Plan to date ({data.kpis.elapsedPeriods}/{data.kpis.totalPeriods} periods)
            </div>
            <div className="kpi-value">{formatMoney(data.kpis.ytdPlan, 'EUR', { compact: true })}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Variance</div>
            <div className={`kpi-value ${deltaClass(data.kpis.variance)}`}>
              <span aria-hidden="true">{deltaGlyph(data.kpis.variance)}</span>{' '}
              {formatMoney(data.kpis.variance, 'EUR', { compact: true })}
            </div>
          </div>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header"><h2>Consumption by line</h2></div>
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>
              Lines consuming faster than time elapsed are flagged (FR-042).
            </caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Entity</th>
                <th scope="col">Category</th>
                <th scope="col" className="num">Plan</th>
                <th scope="col" className="num">Spend</th>
                <th scope="col" className="num">Consumed</th>
                <th scope="col">Pace</th>
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
                      ? <Status tone="bad">Over pace</Status>
                      : <Status tone="ok">On pace</Status>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function VarianceView({ entities }: { entities: Entity[] }): JSX.Element {
  const [entityId, setEntityId] = useState('');
  const [data, setData] = useState<Variance | null>(null);

  useEffect(() => {
    const query = entityId ? `?entityId=${encodeURIComponent(entityId)}` : '';
    api.get<Variance>(`/api/reports/variance${query}`).then(setData).catch(() => setData(null));
  }, [entityId]);

  if (!data) return <p className="empty">Loading…</p>;

  return (
    <>
      <div className="filters">
        <div className="field">
          <label htmlFor="variance-entity">Entity</label>
          <select
            id="variance-entity"
            className="select"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          >
            <option value="">All entities in scope</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.code}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="banner banner-info">
        <span aria-hidden="true">▲</span>
        <span>
          This is a cost tool, so growth is the unwanted direction: increases are shown in the
          danger colour with an up arrow, reductions in the accent colour with a down arrow.
        </span>
      </div>

      <section className="panel">
        <div className="panel-header"><h2>Largest movements</h2></div>
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Entity</th>
                <th scope="col">Category</th>
                <th scope="col" className="num">Prior year</th>
                <th scope="col" className="num">This year</th>
                <th scope="col" className="num">Movement</th>
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
          </table>
        </div>
      </section>
    </>
  );
}

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
      <div className="banner banner-info">
        <span aria-hidden="true">ⓘ</span>
        <span>
          {scope === 'all'
            ? 'Showing every action across all entities and roles.'
            : 'Showing your own actions only. This is enforced in the query, not hidden in the page.'}
        </span>
      </div>

      <div className="filters">
        <div className="field">
          <label htmlFor="audit-kind">Kind</label>
          <select id="audit-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            <option value="change">Change</option>
            <option value="approval">Approval</option>
            <option value="workflow">Workflow</option>
            <option value="governance">Governance</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-search">Search</label>
          <input
            id="audit-search"
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Action or detail"
          />
        </div>
      </div>

      <section className="panel">
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>Append-only. Entries cannot be edited or deleted by anyone (FR-073).</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Role</th>
                <th scope="col">Action</th>
                <th scope="col">Detail</th>
                <th scope="col">Kind</th>
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
          </table>
          {events.length === 0 ? <p className="empty">No matching events.</p> : null}
        </div>
      </section>
    </>
  );
}

export function SubmissionsView({ canDecide }: { canDecide: boolean }): JSX.Element {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const reload = () =>
    api.get<Submission[]>('/api/submissions').then(setSubmissions).catch(() => setSubmissions([]));

  useEffect(() => {
    void reload();
  }, []);

  const decide = async (id: string, decision: 'approve' | 'reject' | 'request_info') => {
    try {
      await api.post(`/api/submissions/${id}/decision`, { decision, comment });
      setComment('');
      setMessage(null);
      await reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not record the decision.');
    }
  };

  return (
    <>
      {message ? <p className="banner banner-error">{message}</p> : null}

      {submissions.length === 0 ? (
        <p className="empty">No submissions for this cycle yet.</p>
      ) : null}

      {canDecide && submissions.length > 0 ? (
        <div className="field">
          <label htmlFor="decision-comment">
            Comment — returned to the budget owner with your decision (FR-052)
          </label>
          <textarea
            id="decision-comment"
            className="input"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
      ) : null}

      {submissions.map((s) => (
        <section className="panel" key={s.id}>
          <div className="panel-header">
            <h2>{s.entityCode} — {s.entityName}</h2>
            <BudgetStateChip state={s.state} />
            <span className="currency-code">
              submitted by {s.submittedBy}, {formatDateTime(s.submittedAt)}
            </span>
          </div>
          <div className="panel-body">
            <p className="currency-code">
              {s.linesApproved} lines approved · {s.linesRejected} rejected
            </p>
            {s.comment ? <p>{s.comment}</p> : null}
            {canDecide && (s.state === 'submitted' || s.state === 'changes_requested') ? (
              <div className="button-row">
                <button type="button" className="button button-primary" onClick={() => decide(s.id, 'approve')}>
                  Approve
                </button>
                <button type="button" className="button" onClick={() => decide(s.id, 'request_info')}>
                  Request more information
                </button>
                <button type="button" className="button button-danger" onClick={() => decide(s.id, 'reject')}>
                  Reject
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </>
  );
}

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
      {message ? <p className="banner banner-error">{message}</p> : null}
      <section className="panel">
        <div className="panel-header"><h2>Cost centre registry</h2></div>
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>
              Managers may only book lines to approved centres. Existing references to a
              rejected or pending centre are surfaced as exceptions, never cleared (INV-2).
            </caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Description</th>
                <th scope="col">Status</th>
                {canApprove ? <th scope="col">Decision</th> : null}
              </tr>
            </thead>
            <tbody>
              {centres.map((c) => (
                <tr key={c.id}>
                  <th scope="row" className="currency-code">{c.code}</th>
                  <td>{c.description}</td>
                  <td>
                    {c.status === 'approved' ? <Status tone="ok">Approved</Status> : null}
                    {c.status === 'pending' ? <Status tone="pending">Pending</Status> : null}
                    {c.status === 'rejected' ? <Status tone="bad">Rejected</Status> : null}
                  </td>
                  {canApprove ? (
                    <td>
                      <div className="button-row">
                        <button type="button" className="button" onClick={() => decide(c.id, 'approved')}>
                          Approve
                        </button>
                        <button type="button" className="button button-danger" onClick={() => decide(c.id, 'rejected')}>
                          Reject
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

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
        <div className={`banner ${integrity.intact ? 'banner-info' : 'banner-error'}`}>
          <span aria-hidden="true">{integrity.intact ? '✓' : '✕'}</span>
          <span>
            {integrity.intact
              ? 'Audit hash chain verified end to end — no entry has been altered or removed.'
              : `Audit chain broken at sequence ${integrity.firstBadSeq}. Investigate immediately.`}
          </span>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header"><h2>Field classification</h2></div>
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>Every field carries exactly one classification (SPEC §9.1).</caption>
            <thead>
              <tr><th scope="col">Field</th><th scope="col">Class</th></tr>
            </thead>
            <tbody>
              {classifications.map((c) => (
                <tr key={c.fieldKey}>
                  <th scope="row" className="currency-code">{c.fieldKey}</th>
                  <td>
                    {c.dataClass === 'personal_data' ? (
                      <Status tone="pending">Personal data</Status>
                    ) : c.dataClass === 'confidential' ? (
                      <Status tone="bad">Confidential</Status>
                    ) : (
                      <Status tone="neutral">{c.dataClass}</Status>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><h2>Retention</h2></div>
        <div className="table-scroll" tabIndex={0} role="group">
          <table>
            <caption>
              Enforced by a scheduled job that writes an audit event per run, including the
              count purged. Retention that is documented but not executed is a finding (PRIV-001).
            </caption>
            <thead>
              <tr><th scope="col">Dataset</th><th scope="col" className="num">Months</th></tr>
            </thead>
            <tbody>
              {retention.map((r) => (
                <tr key={r.dataset}>
                  <th scope="row">{r.dataset}</th>
                  <td className="num">{r.months}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function ValidationBanner({ violations }: { violations: RuleViolation[] }): JSX.Element | null {
  if (violations.length === 0) return null;
  const blocking = violations.filter((v) => v.severity === 'blocking');
  return (
    <div className={`banner ${blocking.length > 0 ? 'banner-error' : 'banner-warn'}`}>
      <span aria-hidden="true">{blocking.length > 0 ? '✕' : '!'}</span>
      <ul>
        {violations.map((v) => (
          <li key={v.code}>
            <strong>{v.severity === 'blocking' ? 'Blocking' : 'Warning'}:</strong> {v.description}{' '}
            ({v.lineIds.length} lines)
          </li>
        ))}
      </ul>
    </div>
  );
}

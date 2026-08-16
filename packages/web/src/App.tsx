/**
 * Application shell.
 *
 * The navigation is built from the caller's capabilities, but that is
 * presentation only — hiding a nav item is not a control. Every route behind it
 * re-checks authorisation server-side (SEC-010), and this file is written on
 * the assumption that a user can reach any endpoint they like by hand.
 *
 * There is no role switcher. The prototype's Admin/Manager/CFO tabs and persona
 * dropdown were demo affordances; identity and role come from Entra ID group
 * membership (SPEC §4).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api.ts';
import { can } from '@spendifre/shared';
import type { BudgetLine, BudgetView, CostCentre, Entity, Me, RuleViolation } from './types.ts';
import { BudgetGrid, BulkBar, type Unit } from './components/BudgetGrid.tsx';
import { LineDrawer } from './components/LineDrawer.tsx';
import {
  AuditView,
  ConsolidationView,
  ConsumptionView,
  CostCentreView,
  GovernanceView,
  SubmissionsView,
  ValidationBanner,
  VarianceView,
} from './components/views.tsx';
import { OperationsView } from './components/OperationsView.tsx';
import { formatMoney } from './format.ts';
import { BudgetStateChip } from './components/Status.tsx';

type ViewKey =
  | 'budget'
  | 'consumption'
  | 'variance'
  | 'consolidation'
  | 'submissions'
  | 'costCentres'
  | 'audit'
  | 'governance'
  | 'operations';

interface NavEntry {
  key: ViewKey;
  label: string;
  glyph: string;
  group: string;
  /** Rendered only when this returns true. Presentation, not protection. */
  visible: (me: Me) => boolean;
}

const NAV: NavEntry[] = [
  { key: 'budget', label: 'Budget entry', glyph: '▦', group: 'Plan', visible: () => true },
  { key: 'consumption', label: 'Actuals', glyph: '◑', group: 'Plan', visible: () => true },
  { key: 'variance', label: 'Variance', glyph: '⇅', group: 'Analyse', visible: () => true },
  {
    key: 'consolidation',
    label: 'Consolidation',
    glyph: '∑',
    group: 'Analyse',
    visible: (me) => can(me.user.role, 'budget.view.any'),
  },
  {
    key: 'submissions',
    label: 'Submissions',
    glyph: '⇢',
    group: 'Approve',
    visible: () => true,
  },
  {
    key: 'costCentres',
    label: 'Cost centres',
    glyph: '⊞',
    group: 'Approve',
    visible: () => true,
  },
  { key: 'audit', label: 'Audit trail', glyph: '☰', group: 'Govern', visible: () => true },
  {
    key: 'governance',
    label: 'Data governance',
    glyph: '⚿',
    group: 'Govern',
    visible: (me) => can(me.user.role, 'governance.edit') || can(me.user.role, 'audit.viewAll'),
  },
  {
    key: 'operations',
    label: 'Operations',
    glyph: '⟳',
    group: 'Govern',
    visible: (me) => can(me.user.role, 'backup.run'),
  },
];

export function App(): JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>('budget');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    api
      .get<Me>('/api/me')
      .then(setMe)
      .catch((e: ApiError) => setBootError(e.status === 401 ? 'signed-out' : e.message));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (bootError === 'signed-out') return <SignedOut />;
  if (bootError) return <p className="banner banner-error">{bootError}</p>;
  if (!me) return <p className="empty">Loading…</p>;

  const groups = [...new Set(NAV.filter((n) => n.visible(me)).map((n) => n.group))];

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <nav className="sidebar" aria-label="Sections">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <SpitfireMark />
          </span>
          <span>
            <span className="brand-name">SPENDIFRE</span>
            <br />
            <span className="brand-sub">FY{me.fiscalYear}</span>
          </span>
        </div>

        {groups.map((group) => (
          <div className="nav" key={group}>
            <div className="nav-heading">{group}</div>
            {NAV.filter((n) => n.group === group && n.visible(me)).map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="nav-item"
                aria-current={view === entry.key ? 'page' : undefined}
                onClick={() => setView(entry.key)}
              >
                <span className="nav-glyph" aria-hidden="true">
                  {entry.glyph}
                </span>
                {entry.label}
              </button>
            ))}
          </div>
        ))}

        <div className="sidebar-footer">
          <div>
            <div className="user-name">{me.user.displayName}</div>
            <div className="user-role">
              {me.user.role.replace(/_/g, ' ')} · {me.region.toUpperCase()}
            </div>
          </div>
          <button
            type="button"
            className="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          <button
            type="button"
            className="button"
            onClick={async () => {
              await api.post('/auth/logout').catch(() => undefined);
              window.location.assign('/');
            }}
          >
            Sign out
          </button>
        </div>
      </nav>

      <main className="main" id="main-content">
        {view === 'budget' ? <BudgetWorkspace me={me} /> : null}
        {view !== 'budget' ? (
          <>
            <header className="header">
              <div>
                <h1>{NAV.find((n) => n.key === view)?.label}</h1>
                <p className="header-sub">FY{me.fiscalYear}, EUR at the year-locked rate</p>
              </div>
            </header>
            {/* tabIndex makes the scroll container reachable by keyboard;
                without it a keyboard user cannot scroll the region at all
                (axe: scrollable-region-focusable). */}
            <div className="view" tabIndex={0} aria-label={`${NAV.find((n) => n.key === view)?.label} content`}>
              {view === 'consolidation' ? <ConsolidationView /> : null}
              {view === 'consumption' ? <ScopedConsumption /> : null}
              {view === 'variance' ? <ScopedVariance /> : null}
              {view === 'submissions' ? (
                <SubmissionsView canDecide={can(me.user.role, 'submission.decide')} />
              ) : null}
              {view === 'costCentres' ? (
                <CostCentreView canApprove={can(me.user.role, 'costCentre.approve')} />
              ) : null}
              {view === 'audit' ? <AuditView /> : null}
              {view === 'governance' ? <GovernanceView /> : null}
              {view === 'operations' ? <OperationsView /> : null}
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

function useEntities(): Entity[] {
  const [entities, setEntities] = useState<Entity[]>([]);
  useEffect(() => {
    api.get<Entity[]>('/api/entities').then(setEntities).catch(() => setEntities([]));
  }, []);
  return entities;
}

function ScopedConsumption(): JSX.Element {
  return <ConsumptionView entities={useEntities()} />;
}

function ScopedVariance(): JSX.Element {
  return <VarianceView entities={useEntities()} />;
}

function BudgetWorkspace({ me }: { me: Me }): JSX.Element {
  const entities = useEntities();
  /** Empty until the user picks one; the effective selection is derived below
   *  rather than defaulted through setState, which would cascade a render. */
  const [chosenEntityId, setChosenEntityId] = useState('');
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [violations, setViolations] = useState<RuleViolation[]>([]);
  const [unit, setUnit] = useState<Unit>('local');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const entityId = chosenEntityId || entities[0]?.id || '';

  useEffect(() => {
    api.get<CostCentre[]>('/api/cost-centres').then(setCostCentres).catch(() => setCostCentres([]));
  }, []);

  const reload = useCallback(() => {
    if (!entityId) return;
    api
      .get<BudgetView>(`/api/budget/${entityId}`)
      .then(setBudget)
      .catch((e: ApiError) => setMessage(e.message));
    api
      .get<{ violations: RuleViolation[] }>(`/api/entities/${entityId}/validation`)
      .then((d) => setViolations(d.violations))
      .catch(() => setViolations([]));
  }, [entityId]);

  useEffect(reload, [reload]);

  const entity = useMemo(() => entities.find((e) => e.id === entityId), [entities, entityId]);
  const canEdit =
    !!entity &&
    can(me.user.role, 'budget.line.edit.own') &&
    (me.user.ownedEntityIds.includes(entity.id) || me.user.role === 'admin') &&
    entity.state !== 'approved' &&
    entity.state !== 'locked';

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setMessage(null);
      reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'The action failed.');
    }
  };

  const setAmount = (line: BudgetLine, period: number, value: string) =>
    run(() =>
      api.put(`/api/lines/${line.id}/amounts`, {
        period,
        amount: value,
        // FR-014: tell the server which unit this was typed in; it converts
        // back to the line's local currency before storing.
        unit,
        version: line.version,
      }),
    );

  const bulk = (body: Record<string, unknown>) =>
    run(async () => {
      await api.post('/api/lines/bulk', { ...body, lineIds: [...selected] });
      setSelected(new Set());
    });

  return (
    <>
      <header className="header">
        <div>
          <h1>Budget entry</h1>
          <p className="header-sub">
            {entity ? `${entity.code} — ${entity.name}` : 'No entity in scope'}
            {budget ? ` · ${formatMoney(budget.entityTotal.plan, 'EUR', { compact: true })} planned` : ''}
          </p>
        </div>

        <div className="header-actions">
          {entity ? <BudgetStateChip state={entity.state} /> : null}

          <div className="field">
            <label htmlFor="entity-select">Entity</label>
            <select
              id="entity-select"
              className="select"
              value={entityId}
              onChange={(e) => setChosenEntityId(e.target.value)}
            >
              {entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} — {e.name}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="field">
            <legend className="visually-hidden">Display currency</legend>
            <div className="button-row">
              <button
                type="button"
                className={`button ${unit === 'local' ? 'button-primary' : ''}`}
                aria-pressed={unit === 'local'}
                onClick={() => setUnit('local')}
              >
                Local
              </button>
              <button
                type="button"
                className={`button ${unit === 'eur' ? 'button-primary' : ''}`}
                aria-pressed={unit === 'eur'}
                onClick={() => setUnit('eur')}
              >
                EUR
              </button>
            </div>
          </fieldset>

          {can(me.user.role, 'budget.submit') && entity ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => run(() => api.post(`/api/entities/${entity.id}/submit`))}
            >
              Submit for review
            </button>
          ) : null}
        </div>
      </header>

      <div className="view" tabIndex={0} aria-label="Budget entry content">
        {message ? <p className="banner banner-error">{message}</p> : null}
        <ValidationBanner violations={violations} />

        <BulkBar
          count={selected.size}
          costCentres={costCentres}
          onUplift={(percent) => bulk({ operation: 'uplift', percent })}
          onReassign={(costCentreId) => bulk({ operation: 'reassign_cost_centre', costCentreId })}
          onCopyPriorYear={() => bulk({ operation: 'copy_prior_year' })}
          onDelete={() => bulk({ operation: 'delete' })}
          onClear={() => setSelected(new Set())}
        />

        {budget ? (
          <BudgetGrid
            view={budget}
            costCentres={costCentres}
            unit={unit}
            canEdit={canEdit}
            selected={selected}
            onToggleSelect={(id) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onSelectAll={(ids, on) => setSelected(on ? new Set(ids) : new Set())}
            onOpenLine={setOpenLine}
            onSetAmount={setAmount}
          />
        ) : (
          <p className="empty">Loading…</p>
        )}
      </div>

      {openLine ? (
        <LineDrawer
          lineId={openLine}
          costCentres={costCentres}
          canEdit={canEdit}
          onClose={() => setOpenLine(null)}
          onChanged={reload}
        />
      ) : null}
    </>
  );
}

function SignedOut(): JSX.Element {
  return (
    <div className="login">
      <div className="login-card">
        <span className="brand-mark" aria-hidden="true">
          <SpitfireMark />
        </span>
        <h1>Spendifre</h1>
        <p>
          Sign in with your Birgma account. Access is granted by Entra ID group membership —
          there is no local account and no password to reset.
        </p>
        <a className="button button-primary" href="/auth/login">
          Sign in with Microsoft Entra ID
        </a>
      </div>
    </div>
  );
}

/** The Spitfire silhouette from the design bundle, authored for 22–36px. */
function SpitfireMark(): JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 64 64" fill="none" role="img" aria-label="Spendifre">
      <g fill="currentColor" transform="translate(0,5)">
        <path d="M58.6 31.2c-1.6 1.9-4.6 3.4-8.8 4.4-3.6.9-7.9 1.5-12.4 1.8-4.7.3-9.6.3-14 .1l-11.8-.7v-6.9l11.8-1.2c2-.2 4.2-.4 6.5-.5 1.2-3.4 3.6-4.6 5.6-3.3 1 .7 1.8 1.9 2.3 3.4 4.6.5 8.9 1.5 12.4 2.9 3 1.2 5.4 2.6 7 4z" />
        <path d="M15.4 30.6 10.4 15.9c-.4-1.2-1.6-1.4-2.2-.2-.8 1.7-1.5 4.4-2 8l-1.3 9.3z" />
        <path d="M15.4 33.4 5.3 32.3c-1-.1-1.2 1.3-.3 1.7l10.4 4.2z" />
        <path d="M41.5 34.2c-5.8.5-11.6 1.7-17.2 3.8-1.4.5-1.2 2 .3 1.8 6.6-.9 13.1-2.4 19.4-4.5z" />
      </g>
    </svg>
  );
}

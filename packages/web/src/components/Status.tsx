/**
 * Status chips.
 *
 * A11Y-001 requires a non-colour cue beside every status colour. The glyph is
 * that cue. It is marked `aria-hidden` because the adjacent label already
 * carries the meaning for a screen reader — announcing "check mark approved"
 * would be noise, but a sighted user with a colour vision deficiency needs the
 * shape.
 */

import type { ReactNode } from 'react';
import type { RuleViolation } from '../types.ts';
import { t } from '../i18n.ts';

export type Tone = 'ok' | 'pending' | 'bad' | 'neutral';

const GLYPH: Record<Tone, string> = {
  ok: '✓',
  pending: '◷',
  bad: '✕',
  neutral: '·',
};

export function Status({ tone, children }: { tone: Tone; children: ReactNode }): JSX.Element {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      {children}
    </span>
  );
}

const BUDGET_STATE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  submitted: 'pending',
  changes_requested: 'bad',
  approved: 'ok',
  locked: 'ok',
};

const BUDGET_STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  locked: 'Locked',
};

export function BudgetStateChip({ state }: { state: string }): JSX.Element {
  return (
    <Status tone={BUDGET_STATE_TONE[state] ?? 'neutral'}>
      {BUDGET_STATE_LABEL[state] ?? state}
    </Status>
  );
}

export function CostCentreChip({
  code,
  status,
}: {
  code: string | null;
  status: string | null;
}): JSX.Element {
  if (!code) return <Status tone="bad">{t('status.notSet')}</Status>;
  // INV-2: a line booked to a rejected or pending centre keeps showing it,
  // flagged, rather than being silently cleared.
  if (status === 'approved') return <span className="currency-code">{code}</span>;
  return (
    <Status tone={status === 'rejected' ? 'bad' : 'pending'}>
      {code} — {status === 'rejected' ? 'rejected' : 'pending'}
    </Status>
  );
}

/**
 * FR-057 validation summary.
 *
 * Lives here rather than in `views.tsx` because the budget workspace needs it
 * on first paint. Keeping it in `views.tsx` meant that module was both
 * statically and dynamically imported, and a bundler resolves that by not
 * splitting it at all — the lazy imports were inert.
 */
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

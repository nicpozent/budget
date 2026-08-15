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
  if (!code) return <Status tone="bad">Not set</Status>;
  // INV-2: a line booked to a rejected or pending centre keeps showing it,
  // flagged, rather than being silently cleared.
  if (status === 'approved') return <span className="currency-code">{code}</span>;
  return (
    <Status tone={status === 'rejected' ? 'bad' : 'pending'}>
      {code} — {status === 'rejected' ? 'rejected' : 'pending'}
    </Status>
  );
}

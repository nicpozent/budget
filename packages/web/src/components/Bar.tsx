/**
 * Bar charts, drawn in the DOM.
 *
 * SVG rather than a div with a percentage width, because SEC-032's CSP has no
 * `unsafe-inline` and that blocks inline `style` attributes as well as inline
 * `<style>` blocks — a React `style={{ width }}` prop would simply not render.
 * SVG's `width` is a presentational attribute, not CSS, so it is unaffected.
 *
 * No charting library, for the same reason plus ADR-0004: a canvas chart is
 * unreadable to a screen reader and a dependency inside the trust boundary.
 * The track is `aria-hidden`; the figure beside it is the real content, and
 * colour is never the only carrier of meaning (A11Y-001).
 *
 * Both shapes lived here twice — an unlabelled track in `reports.tsx` and a
 * labelled row in `views.tsx`, with the same reasoning written out in both
 * files and the same clamp arithmetic copied. One definition, two exports.
 */

import { formatMoney } from '../format.ts';

const share = (value: number, max: number): number =>
  max > 0 && Number.isFinite(value) ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

/** The track alone, for a table cell that already has its label in the row. */
export function BarTrack({ value, max }: { value: number; max: number }): JSX.Element {
  return (
    <svg className="bar-track" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
      <rect className="bar-fill" x="0" y="0" width={share(value, max)} height="14" rx="1.5" />
    </svg>
  );
}

/** Label, track and formatted value — the standalone chart row. */
export function BarRow({ label, value, max, currency = 'EUR' }: {
  label: string;
  value: string;
  max: number;
  currency?: string;
}): JSX.Element {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <BarTrack value={Number(value)} max={max} />
      <span className="num">{formatMoney(value, currency, { compact: true })}</span>
    </div>
  );
}

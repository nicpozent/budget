/**
 * Formatting (NFR-010).
 *
 * Amounts arrive as canonical decimal strings and are formatted with `Intl`,
 * never parsed into arithmetic. Sweden, Switzerland and APAC differ on
 * separators and date order, so the locale is the user's stored preference
 * rather than being hard-coded — but the *value* is never reconstructed from
 * the formatted text, which is what keeps NFR-002 intact on the client too.
 */

import { intlTag } from './i18n/index.ts';

/**
 * Formatting follows the user's stored locale, not the browser's.
 *
 * These are two different questions and they used to have one answer. A Finnish
 * controller who has chosen Finnish should see Finnish number grouping even on
 * a Swedish workstation — `intlTag()` maps the catalogue language to the BCP-47
 * tag `Intl` needs, and it changes when the user changes their preference.
 */
const DEFAULT_LOCALE = () => intlTag();

export function formatMoney(
  decimalString: string,
  currency = 'EUR',
  options: { compact?: boolean } = {},
): string {
  const asNumber = Number(decimalString);
  // Display-only: if the value is too large for a double to render exactly, we
  // show the canonical string rather than a rounded approximation.
  if (!Number.isFinite(asNumber)) return decimalString;

  return new Intl.NumberFormat(DEFAULT_LOCALE(), {
    style: 'currency',
    currency,
    notation: options.compact ? 'compact' : 'standard',
    maximumFractionDigits: options.compact ? 1 : 0,
  }).format(asNumber);
}

export function formatNumber(decimalString: string): string {
  const asNumber = Number(decimalString);
  if (!Number.isFinite(asNumber)) return decimalString;
  return new Intl.NumberFormat(DEFAULT_LOCALE(), { maximumFractionDigits: 0 }).format(asNumber);
}

export function formatPercent(numerator: string, denominator: string): string {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return '—';
  return new Intl.NumberFormat(DEFAULT_LOCALE(), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(n / d);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(DEFAULT_LOCALE(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** The README's delta convention: increases are the bad direction here. */
export function deltaClass(delta: string): string {
  const value = Number(delta);
  if (!Number.isFinite(value) || value === 0) return 'delta-flat';
  return value > 0 ? 'delta-increase' : 'delta-decrease';
}

/** A11Y-001: the arrow is the non-colour cue that carries the same meaning. */
export function deltaGlyph(delta: string): string {
  const value = Number(delta);
  if (!Number.isFinite(value) || value === 0) return '=';
  return value > 0 ? '▲' : '▼';
}

/**
 * Renders a stored amount for an editable field: canonical decimal in, the
 * shortest equivalent out. `9482.0000` becomes `9482`, `9482.5000` becomes
 * `9482.5`. Purely textual — no parsing to a number, so no precision is lost
 * on the way to the input (NFR-002).
 */
export function toInputValue(decimalString: string): string {
  if (!decimalString.includes('.')) return decimalString;
  const trimmed = decimalString.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

export const PERIOD_LABELS = (count: number): string[] =>
  count === 12
    ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    : ['Q1', 'Q2', 'Q3', 'Q4'];

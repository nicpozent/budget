/**
 * The string catalogue (NFR-010).
 *
 * Runs without a browser. What needs a browser — that the views render, that
 * the lazy chunks load under the real CSP, that axe is clean — lives in
 * a11y.test.ts, which drives one.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EN } from '../packages/web/src/i18n/en.ts';
import { SV } from '../packages/web/src/i18n/sv.ts';
import { NB } from '../packages/web/src/i18n/nb.ts';
import { DA } from '../packages/web/src/i18n/da.ts';
import { FI } from '../packages/web/src/i18n/fi.ts';
import { FR } from '../packages/web/src/i18n/fr.ts';
import {
  LOCALES, LOCALE_NAMES, guessLocale, isLocale, setLocale, t,
} from '../packages/web/src/i18n/index.ts';

const WEB_SRC = fileURLToPath(new URL('../packages/web/src', import.meta.url));

const CATALOGUES = { en: EN, sv: SV, nb: NB, da: DA, fi: FI, fr: FR } as const;

/** Keys whose translation is byte-identical to the English source. */
function identicalKeys(locale: keyof typeof CATALOGUES): string[] {
  return Object.entries(EN)
    .filter(([key, english]) => CATALOGUES[locale][key as keyof typeof EN] === english)
    .map(([key]) => key);
}

// Words that are genuinely the same in the target language, not forgotten ones.
// Each was checked individually: "Plan (EUR)" is identical in all four
// Germanic/Romance targets, "Period" is Swedish, "Download" is the usual Danish
// borrowing, and French keeps Sections/Total/Justification/Code.
const ALLOWED_IDENTICAL = new Set([
  'alloc.driver', 'alloc.pool', 'alloc.total', 'app.name', 'app.sections', 'budget.eur',
  'drawer.justification', 'drawer.period', 'drawer.plan', 'drawer.total', 'fx.drift',
  'grid.status', 'grid.total', 'nav.consolidation', 'nav.trend', 'ops.download',
  'ops.region', 'ops.status', 'selftest.status', 'signIn.title', 'trend.total',
  'views.action', 'views.code', 'views.description', 'views.plan', 'views.planEur',
  'views.status',
  // "Scenario" is the same word in Swedish and Norwegian; "Versions",
  // "Actions" and "Note" are spelled the same in French, and "Note" in Danish.
  'scenario.kind.scenario', 'scenario.versions', 'scenario.actions', 'scenario.note',
  // "Driver" is the same word in Norwegian and Danish; "Actions" and "Sites"
  // in French; "Per" in Swedish, Norwegian and Finnish; "Definition" in Danish.
  'drivers.driver', 'drivers.actions', 'drivers.key.sites', 'drivers.perSource',
  'drivers.definition',
]);

describe('NFR-010 catalogues', () => {
  /**
   * `satisfies Catalogue` already makes a missing key a compile error. This
   * asserts the other direction — a key present in a translation but *not* in
   * English, which the type system permits and which means a string nobody
   * renders.
   */
  it.each(LOCALES)('%s has exactly the English key set', (locale) => {
    const english = Object.keys(EN).sort();
    expect(Object.keys(CATALOGUES[locale]).sort()).toEqual(english);
  });

  it.each(LOCALES)('%s carries the same placeholders as English', (locale) => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const wrong: string[] = [];

    for (const [key, english] of Object.entries(EN)) {
      const translated = CATALOGUES[locale][key as keyof typeof EN];
      const expected = placeholders(english);
      const actual = placeholders(translated);
      // A dropped {amount} renders a sentence with the number missing; an
      // invented one renders a literal brace. Both are silent in production.
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        wrong.push(`${key}: expected ${expected.join(',') || 'none'}, got ${actual.join(',') || 'none'}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it.each(LOCALES)('%s leaves no string untranslated except proper nouns', (locale) => {
    if (locale === 'en') return;
    const identical = identicalKeys(locale).filter((key) => !ALLOWED_IDENTICAL.has(key));
    // Not a hard rule — some words genuinely coincide — but an untouched string
    // is usually a forgotten one, and the allow-list makes each coincidence a
    // decision someone made.
    expect(identical, `untranslated in ${locale}:\n${identical.join('\n')}`).toEqual([]);
  });

  /**
   * The allow-list above is the same shape as the backup exclusion list, and
   * carries the same failure mode: an entry nobody needs looks like a decision
   * someone made. If a translation later diverges, its exemption should go.
   */
  it('has no unnecessary entries in the identical-string allow-list', () => {
    const stillIdentical = new Set(
      LOCALES.filter((l) => l !== 'en').flatMap((l) => identicalKeys(l)),
    );
    const unnecessary = [...ALLOWED_IDENTICAL].filter((key) => !stillIdentical.has(key));
    expect(
      unnecessary,
      `these keys are no longer identical in any locale — drop them from the allow-list:\n${unnecessary.join('\n')}`,
    ).toEqual([]);
  });

  it('names every locale in its own language', () => {
    for (const locale of LOCALES) {
      expect(LOCALE_NAMES[locale], `${locale} has no endonym`).toBeTruthy();
    }
    // A picker that says "Swedish" to a Swedish-only reader is useless.
    expect(LOCALE_NAMES.sv).toBe('Svenska');
    expect(LOCALE_NAMES.fi).toBe('Suomi');
  });

  it('recognises only known locales', () => {
    expect(isLocale('sv')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('switches the active catalogue', () => {
    setLocale('fr');
    expect(t('app.signOut')).toBe('Se déconnecter');
    setLocale('fi');
    expect(t('app.signOut')).toBe('Kirjaudu ulos');
    setLocale('en');
    expect(t('app.signOut')).toBe('Sign out');
  });

  it('falls back to English when the browser offers nothing known', () => {
    expect(guessLocale()).toBe('en');
  });
});

describe('NFR-010 string catalogue', () => {
  it('substitutes named parameters', () => {
    expect(t('app.fiscalYear', { year: 2026 })).toBe('FY2026');
    expect(t('budget.planned', { amount: '€1.2M' })).toBe('€1.2M planned');
  });

  it('leaves an unmatched placeholder visible rather than blanking it', () => {
    // A sentence with a visible hole is a bug someone reports; a sentence that
    // silently drops its number is a bug that ships.
    expect(t('app.fiscalYear', {})).toBe('FY{year}');
  });

  it('returns the template untouched when no parameters are given', () => {
    expect(t('nav.budget')).toBe('Budget entry');
  });

  /**
   * The catalogue is only worth having if the views actually use it, and
   * "externalise the strings" is exactly the kind of change that rots one JSX
   * file at a time. This walks the client source for user-visible text that
   * bypassed `t()`.
   *
   * Two shapes are checked: text between tags on one line (`<th>Entity</th>`)
   * and text on its own line inside an element. Attribute values are excluded —
   * `className`, `role` and `scope` are string literals and none is
   * user-visible — as are comments and import lists.
   *
   * This is a lint, not a proof. It cannot see a string built in a variable and
   * passed to a prop, and it deliberately allows single words that are units or
   * codes. It catches the regression it is aimed at: a new view written with its
   * text inline.
   */
  it('has no untranslated text in JSX', async () => {
    const offenders: string[] = [];
    /** Between tags: `>Some text<`. Rejects anything containing a brace. */
    const INLINE = />([A-Z][A-Za-z][^<>{}]*[a-z][^<>{}]*)</g;
    /** Prose on its own line. */
    const OWN_LINE = /^[A-Z][A-Za-z][A-Za-z ’'.,—-]{3,}$/;

    for await (const entry of glob('**/*.tsx', { cwd: WEB_SRC })) {
      const source = await readFile(`${WEB_SRC}/${entry}`, 'utf8');
      let inBlockComment = false;
      let inImport = false;

      for (const [index, line] of source.split('\n').entries()) {
        const trimmed = line.trim();

        if (trimmed.startsWith('/*')) inBlockComment = true;
        if (inBlockComment) {
          if (trimmed.includes('*/')) inBlockComment = false;
          continue;
        }
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

        if (trimmed.startsWith('import ')) inImport = !trimmed.includes(';');
        else if (inImport) {
          if (trimmed.includes(';')) inImport = false;
          continue;
        }
        if (trimmed.startsWith('import ')) continue;

        const found = new Set<string>();
        for (const match of trimmed.matchAll(INLINE)) found.add(match[1]!.trim());
        if (OWN_LINE.test(trimmed)) found.add(trimmed);

        for (const text of found) {
          if (text.length < 4) continue;
          offenders.push(`${entry}:${index + 1}  ${text}`);
        }
      }
    }

    expect(offenders, `untranslated JSX text:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('WCAG 4.1.3 status messages', () => {
  /**
   * A banner appears without focus moving, so a screen reader announces it only
   * if it is a live region. axe cannot catch this — a `<p>` with no role is
   * valid markup — so it is asserted here against the source.
   *
   * `alert` for errors (assertive: a failed save must interrupt) and `status`
   * for informational banners (polite: a completed backup can wait).
   */
  it('marks every banner as a live region', async () => {
    const missing: string[] = [];

    for await (const entry of glob('**/*.tsx', { cwd: WEB_SRC })) {
      const lines = (await readFile(`${WEB_SRC}/${entry}`, 'utf8')).split('\n');
      for (const [index, line] of lines.entries()) {
        if (!/className=[{"`][^>]*\bbanner\b/.test(line)) continue;
        // A window rather than the exact element: the role may sit on a
        // following line when the element is wrapped, and locating the opening
        // tag's closing bracket is unreliable when a ternary contains `>`.
        // Imprecise on purpose — this is a lint against a regression, and the
        // real markup is checked by axe in a browser.
        const window = lines.slice(Math.max(0, index - 2), index + 8).join(' ');
        // Two conditions rather than one pattern: the role may be a ternary
        // (`role={blocking ? 'alert' : 'status'}`), so requiring the value to
        // follow `role=` directly would miss it.
        const declaresRole = /\brole=/.test(window);
        const namesLiveRegion = /['"](?:alert|status)['"]/.test(window);
        if (!declaresRole || !namesLiveRegion) {
          missing.push(`${entry}:${index + 1}  ${line.trim()}`);
        }
      }
    }

    expect(missing, `banners without a live-region role:\n${missing.join('\n')}`).toEqual([]);
  });
});

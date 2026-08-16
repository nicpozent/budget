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
import { t } from '../packages/web/src/i18n.ts';

const WEB_SRC = fileURLToPath(new URL('../packages/web/src', import.meta.url));

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

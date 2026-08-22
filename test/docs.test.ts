/**
 * Figures claimed in the documentation, checked against the code.
 *
 * Twenty-two places across nine documents said "203 assertions" and
 * "360 tests" long after both were wrong, and one of them was the Statement of
 * Work. Nobody lied; the numbers were true when written and nothing made them
 * false out loud. A figure in prose is an assertion with no test behind it,
 * and this repository's whole argument is that such assertions rot.
 *
 * So the structural ones are gated here. They change rarely — a new capability,
 * a new view, a new migration — and when they do, the diff that changes the
 * code has to change the sentence, which is exactly the moment someone knows
 * what the new sentence should say.
 *
 * Two deliberate exclusions:
 *
 *   Test counts.  They move with every commit, so gating them exactly would
 *                 mean a doc edit in every pull request and a number nobody
 *                 reads. They were removed from the prose instead; the
 *                 evaluation keeps one, dated, as a snapshot rather than a
 *                 claim about now.
 *   Prose.        This checks arithmetic, not accuracy. A document can be
 *                 numerically perfect and describe a system that no longer
 *                 exists. That is what review is for.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, ROLES } from '@spendifre/shared';

const read = (path: string): string => readFileSync(path, 'utf8');

/** Every markdown file that makes claims, so a new document is covered too. */
function allDocs(): { path: string; text: string }[] {
  const roots = ['docs', 'SoW', '.'];
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.md')) out.push({ path: full, text: read(full) });
    }
  };
  for (const r of roots) walk(r, r === '.' ? 3 : 0);
  return out;
}

/** Count entries in a `export const NAME = [ ... ] as const` block. */
function countConstArray(source: string, name: string): number {
  const start = source.indexOf(`export const ${name} = [`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = source.indexOf('] as const', start);
  return source.slice(start, end).split('\n').filter((l) => /^\s+'/.test(l)).length;
}

describe('documented figures match the code', () => {
  it('states the right number of capabilities and roles', () => {
    const wrong: string[] = [];
    // "9 roles × 24 capabilities" and "(28 capabilities × 9 roles)" — both
    // orders appear in the docs, so both are matched.
    const patterns = [
      /(\d+)\s+roles?\s*[×x]\s*(\d+)\s+capabilit/gi,
      /\((\d+)\s+capabilit\w*\s*[×x]\s*(\d+)\s+roles?\)/gi,
    ];
    for (const { path, text } of allDocs()) {
      for (const [i, pattern] of patterns.entries()) {
        for (const m of text.matchAll(pattern)) {
          const [roles, caps] = i === 0
            ? [Number(m[1]), Number(m[2])]
            : [Number(m[2]), Number(m[1])];
          if (roles !== ROLES.length || caps !== CAPABILITIES.length) {
            wrong.push(`${path}: "${m[0]}" — actually ${ROLES.length} roles × ${CAPABILITIES.length} capabilities`);
          }
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('states the right number of views', () => {
    const app = read('packages/web/src/App.tsx');
    const declared = app
      .slice(app.indexOf('type ViewKey'), app.indexOf('interface NavEntry'))
      .split('\n')
      .filter((l) => /^\s+\|\s+'/.test(l)).length;

    const wrong: string[] = [];
    for (const { path, text } of allDocs()) {
      for (const m of text.matchAll(/(\d+)\s+views\b/gi)) {
        // `screenreader.test.ts` covers the views with tables, a subset named
        // in the VPAT as such. Anything claiming a total has to be the total.
        if (/views with tables/.test(text.slice(m.index, m.index! + 40))) continue;
        if (Number(m[1]) !== declared) {
          wrong.push(`${path}: "${m[0]}" — the app declares ${declared}`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('states the right number of runtime self-test checks', () => {
    const checks = (read('packages/api/src/services/selftest.ts').match(/^ {4}id: '/gm) ?? []).length;
    expect(checks).toBeGreaterThan(10);

    const wrong: string[] = [];
    for (const { path, text } of allDocs()) {
      for (const m of text.matchAll(/(\d+)\s+read-only checks/gi)) {
        if (Number(m[1]) !== checks) wrong.push(`${path}: "${m[0]}" — actually ${checks}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('states the right number of production dependencies', () => {
    const deps = Object.keys(
      (JSON.parse(read('packages/api/package.json')) as { dependencies?: Record<string, string> })
        .dependencies ?? {},
    // The workspace package is this repository's own code, not a supply-chain
    // dependency, and the claim in the docs is about the latter.
    ).filter((d) => !d.startsWith('@spendifre/'));

    const wrong: string[] = [];
    for (const { path, text } of allDocs()) {
      for (const m of text.matchAll(/(\d+)\s+direct production dependencies/gi)) {
        if (Number(m[1]) !== deps.length) {
          wrong.push(`${path}: "${m[0]}" — actually ${deps.length}: ${deps.join(', ')}`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('names only migrations that exist', () => {
    const present = new Set(
      readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, 3)),
    );
    const wrong: string[] = [];
    for (const { path, text } of allDocs()) {
      for (const m of text.matchAll(/migration (\d{3})\b/gi)) {
        if (!present.has(m[1]!)) wrong.push(`${path}: "${m[0]}" does not exist`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('references only source files that exist', () => {
    // A document pointing at a moved or deleted module is worse than one that
    // says nothing: it sends a reader looking for something that is not there.
    // `views.tsx` was cited in four documents after it was split apart.
    const wrong: string[] = [];
    const pattern = /`((?:packages|tools|test|db|ops)\/[\w./-]+\.(?:ts|tsx|sql|mjs|json))`/g;
    for (const { path, text } of allDocs()) {
      for (const m of text.matchAll(pattern)) {
        // The architecture docs write `db/pool.ts` for the module the API
        // package calls `db/pool.ts` internally. Both readings are legitimate,
        // so a path that resolves either way counts as present.
        const candidates = [m[1]!, `packages/api/src/${m[1]}`];
        if (!candidates.some((c) => { try { readFileSync(c); return true; } catch { return false; } })) {
          wrong.push(`${path}: ${m[1]} does not exist`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('has a capability count worth gating', () => {
    // Guards the guard: if the parse silently returned nothing, every check
    // above would pass over an empty set.
    expect(CAPABILITIES.length).toBeGreaterThan(20);
    expect(ROLES.length).toBeGreaterThan(5);
    expect(countConstArray(read('packages/shared/src/authz.ts'), 'CAPABILITIES'))
      .toBe(CAPABILITIES.length);
  });
});

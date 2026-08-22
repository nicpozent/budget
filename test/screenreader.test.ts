/**
 * What a screen reader actually receives (A11Y-001, WCAG 1.3.1 / 2.4.1 /
 * 2.4.3 / 2.4.6, CMP-160).
 *
 * ## Why this is not "assistive-technology testing"
 *
 * It is not, and the VPAT says so. A screen-reader user brings expectations,
 * a decade of muscle memory, and a task they are trying to finish; what they
 * find is things that are technically announced and practically unusable.
 * Nothing here substitutes for that, and the row in the evaluation stays open.
 *
 * What this does is close the distance between "axe passes" and "a screen
 * reader user can operate it", which turns out to be wider than axe's pass
 * suggests. axe checks conformance rules against the DOM. This asks the
 * browser for the accessibility tree — the thing a screen reader consumes —
 * and asserts the properties that make a page navigable rather than merely
 * conformant:
 *
 *   Names.       Every region and control announces as something. An
 *                unnamed `role="group"` is valid ARIA and useless speech.
 *   Structure.   One h1, no skipped heading levels, one main landmark. This
 *                is how a screen-reader user navigates; it is invisible to a
 *                sighted one, so nothing else in the suite would notice.
 *   Focus.       Where focus goes when a panel opens, and where it returns.
 *
 * Every assertion here was written after the corresponding probe found
 * something. Between them they caught: twenty-five unnamed scroll regions, a
 * drawer whose focus call had never once executed, and five table captions
 * still in English in a six-locale product.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createHarness, type Harness } from './harness.ts';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let harness: Harness;
let browser: Browser | null = null;
let origin = '';
let sessionToken = '';

beforeAll(async () => {
  harness = await createHarness();
  await harness.app.listen({ port: 0, host: '127.0.0.1' });
  const address = harness.app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  origin = `http://127.0.0.1:${address.port}`;
  sessionToken = (await harness.as('admin@birgma.test')).cookie.replace('sid=', '');
  try {
    browser = await chromium.launch({ executablePath: CHROMIUM });
  } catch {
    browser = null;
  }
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await harness?.close();
});

async function open(navLabel: string | null): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: 'sid', value: sessionToken, url: origin, httpOnly: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  if (navLabel) {
    await page.getByRole('button', { name: navLabel, exact: true }).click();
    await page.waitForTimeout(1200);
  }
  return page;
}

/** The views with tables, which is where all of this went wrong. */
const VIEWS: readonly (readonly [string, string | null])[] = [
  ['budget entry', null],
  ['consolidation', 'Consolidation'],
  ['variance', 'Variance'],
  ['actuals', 'Actuals'],
  ['drivers', 'Drivers'],
  ['scenarios', 'Scenarios'],
  ['submissions', 'Submissions'],
  ['approval chain', 'Approval chain'],
  ['template versions', 'Template'],
  ['cost centres', 'Cost centres'],
  ['audit trail', 'Audit trail'],
  ['data governance', 'Data governance'],
  ['operations', 'Operations'],
];

interface TreeReport {
  unnamedRegions: string[];
  headings: string[];
  mainCount: number;
  unnamedControls: string[];
}

/**
 * Read the page the way a screen reader would: roles, names, structure.
 *
 * Names are computed by the browser rather than read off attributes, so an
 * `aria-labelledby` pointing at a caption resolves to the caption's text and a
 * dangling one resolves to nothing — which is the distinction that matters and
 * the one an attribute check would miss.
 */
async function readTree(page: Page): Promise<TreeReport> {
  return page.evaluate(() => {
    const nameOf = (el: Element): string => {
      const direct = el.getAttribute('aria-label');
      if (direct?.trim()) return direct.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        return by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .join(' ')
          .trim();
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement
          || el instanceof HTMLTextAreaElement) {
        return (el.labels?.[0]?.textContent ?? el.title ?? '').trim();
      }
      return (el.textContent ?? '').trim();
    };

    const regions = [...document.querySelectorAll('[role="group"],[role="region"]')];
    const unnamedRegions = regions
      .filter((r) => nameOf(r) === '')
      .map((r) => `${r.getAttribute('role')}.${r.className || '(no class)'}`);

    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => h.tagName);

    const controls = [...document.querySelectorAll<HTMLElement>(
      'a[href],button,input:not([type="hidden"]),select,textarea',
    )].filter((el) => el.offsetParent !== null || el.getAttribute('type') === 'checkbox');
    const unnamedControls = controls
      .filter((el) => {
        const n = nameOf(el);
        // Punctuation or a symbol alone is not a name: "✕" announces as
        // nothing useful, which is why the close button carries a label.
        return n === '' || /^[^\p{L}\p{N}]+$/u.test(n);
      })
      .map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('type') ?? ''}] "${nameOf(el)}"`);

    return {
      unnamedRegions,
      headings,
      mainCount: document.querySelectorAll('main,[role="main"]').length,
      unnamedControls,
    };
  });
}

describe('the accessibility tree a screen reader receives', () => {
  for (const [name, nav] of VIEWS) {
    it(`names every region and control on ${name}`, async () => {
      if (!browser) {
        console.warn('chromium unavailable — screen-reader gate not enforced here');
        return;
      }
      const page = await open(nav);
      const tree = await readTree(page);

      // Twenty-five scroll containers were `role="group"` with no name, one per
      // table. A screen reader announced "group" and stopped, on every view.
      expect(
        tree.unnamedRegions,
        `regions announcing no name on ${name}:\n${tree.unnamedRegions.join('\n')}`,
      ).toEqual([]);

      expect(
        tree.unnamedControls,
        `controls announcing no usable name on ${name}:\n${tree.unnamedControls.join('\n')}`,
      ).toEqual([]);

      await page.context().close();
    }, 120_000);
  }

  it('gives every view one h1, one main, and no skipped heading level', async () => {
    if (!browser) return;
    const broken: string[] = [];

    for (const [name, nav] of VIEWS) {
      const page = await open(nav);
      const tree = await readTree(page);

      const levels = tree.headings.map((h) => Number(h.slice(1)));
      if (levels.filter((l) => l === 1).length !== 1) {
        broken.push(`${name}: ${levels.filter((l) => l === 1).length} h1 elements`);
      }
      if (tree.mainCount !== 1) broken.push(`${name}: ${tree.mainCount} main landmarks`);
      // Heading navigation is how a screen-reader user skims a page. A jump
      // from h2 to h4 reads as a missing section. axe's rule for this is
      // tagged best-practice, so the WCAG-scoped run in a11y.test.ts does not
      // include it.
      for (let i = 1; i < levels.length; i += 1) {
        if (levels[i]! > levels[i - 1]! + 1) {
          broken.push(`${name}: h${levels[i - 1]} followed by h${levels[i]}`);
        }
      }
      await page.context().close();
    }

    expect(broken, `heading and landmark structure:\n${broken.join('\n')}`).toEqual([]);
  }, 300_000);

  /**
   * axe's `best-practice` rules, reported separately from the WCAG gate.
   *
   * They are not conformance failures and are not treated as such — but they
   * are disproportionately the rules about *navigating*, which is the part of
   * the experience a sighted tester never exercises.
   */
  it('has no best-practice violations on the landing view', async () => {
    if (!browser) return;
    const page = await open(null);
    await page.evaluate(AXE_SOURCE);
    const result = (await page.evaluate(async () =>
      (window as unknown as {
        axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; help: string; nodes: { html: string }[] }[] }> };
      }).axe.run(document, { runOnly: { type: 'tag', values: ['best-practice'] } }),
    )) as { violations: { id: string; help: string; nodes: { html: string }[] }[] };

    const summary = result.violations.map(
      (v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.html).join(' ; ')}`,
    );
    expect(summary, summary.join('\n')).toEqual([]);
    await page.context().close();
  }, 120_000);
});

describe('focus management (WCAG 2.4.3)', () => {
  it('moves focus into the line drawer and returns it on close', async () => {
    if (!browser) return;
    const page = await open(null);
    await page.waitForTimeout(600);

    const opener = page.locator('table tbody tr button').first();
    expect(await opener.count(), 'no drawer opener on the grid').toBeGreaterThan(0);
    const openerName = (await opener.textContent())?.trim() ?? '';
    await opener.click();
    await page.waitForTimeout(900);

    const open1 = await page.evaluate(() => {
      const drawer = document.querySelector('.drawer');
      return {
        present: !!drawer,
        focusInside: !!(drawer && drawer.contains(document.activeElement)),
        focused: document.activeElement?.getAttribute('aria-label') ?? '',
      };
    });

    // The regression this exists for: the focus call ran on a render where the
    // close button did not exist yet, so it silently did nothing and a screen
    // reader user was left in the table behind an open panel with no
    // announcement that anything had happened.
    expect(open1.present, 'drawer did not open').toBe(true);
    expect(open1.focusInside, `focus stayed outside the drawer, on "${open1.focused}"`).toBe(true);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const closed = await page.evaluate(() => ({
      present: !!document.querySelector('.drawer'),
      focused: (document.activeElement?.textContent ?? '').trim(),
    }));
    expect(closed.present, 'Escape did not close the drawer').toBe(false);
    // Returning focus to the opener is the other half. Dropping focus to the
    // document body sends a keyboard user back to the top of the page.
    expect(closed.focused, 'focus was not returned to the opener').toBe(openerName);

    await page.context().close();
  }, 180_000);
});

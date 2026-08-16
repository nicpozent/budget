/**
 * Captures the screenshots used by docs/user-guide.
 *
 * Runs against a locally seeded instance with DEV_AUTH=on, signing in as each
 * persona in turn so every shot shows the application exactly as that role sees
 * it — including which navigation items are absent. That is the point: the
 * guide documents per-role visibility, so the screenshots have to be per-role
 * rather than one admin session with sections cropped out.
 *
 *   node tools/capture-screens.mjs [baseUrl] [outDir]
 */

import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8080';
const OUT = process.argv[3] ?? 'docs/user-guide/images';
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const VIEWPORT = { width: 1440, height: 900 };

async function signIn(context, email) {
  const page = await context.newPage();
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
  const state = new URL(page.url()).searchParams.get('state');
  await page.goto(`${BASE}/auth/dev-login?state=${state}&email=${encodeURIComponent(email)}`, {
    waitUntil: 'networkidle',
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return page;
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.warn(`  ${name}.png`);
}

/** `exact` matters: nav labels are substrings of budget line names. */
const nav = (page, label) => page.getByRole('button', { name: label, exact: true }).click();

const browser = await chromium.launch({ executablePath: CHROMIUM });
await mkdir(OUT, { recursive: true });

// --- Signed out -------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '01-sign-in');
  await context.close();
}

// --- Budget owner (Finance Manager) ----------------------------------------
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await signIn(context, 'finance@birgma.test');

  await shot(page, '10-owner-budget-grid');

  // Line detail drawer — click the first line name in the grid.
  await page.locator("tbody th[scope='row'] button").first().click();
  await page.waitForTimeout(1200);
  await shot(page, '11-owner-line-drawer');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Bulk bar — select two lines.
  const boxes = page.locator("tbody input[type='checkbox']");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.waitForTimeout(500);
  await shot(page, '12-owner-bulk-operations');
  await boxes.nth(0).uncheck();
  await boxes.nth(1).uncheck();

  // EUR toggle.
  await page.getByRole('button', { name: 'EUR', exact: true }).click();
  await page.waitForTimeout(600);
  await shot(page, '13-owner-eur-toggle');

  await nav(page, 'Actuals');
  await page.waitForTimeout(1400);
  await shot(page, '14-owner-actuals');

  await nav(page, 'Variance');
  await page.waitForTimeout(1400);
  await shot(page, '15-owner-variance');

  await nav(page, 'Submissions');
  await page.waitForTimeout(1200);
  await shot(page, '16-owner-submissions');

  await nav(page, 'Audit trail');
  await page.waitForTimeout(1200);
  await shot(page, '17-owner-audit-own-only');

  await context.close();
}

// --- CFO --------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await signIn(context, 'cfo@birgma.test');

  await shot(page, '20-cfo-landing-read-only');

  await nav(page, 'Submissions');
  await page.waitForTimeout(1400);
  await shot(page, '21-cfo-submissions');

  await nav(page, 'Cost centres');
  await page.waitForTimeout(1200);
  await shot(page, '22-cfo-cost-centres');

  await nav(page, 'Consolidation');
  await page.waitForTimeout(1600);
  await shot(page, '23-cfo-consolidation');

  await nav(page, 'Audit trail');
  await page.waitForTimeout(1400);
  await shot(page, '24-cfo-audit-all');

  await nav(page, 'Data governance');
  await page.waitForTimeout(1400);
  await shot(page, '25-cfo-governance');

  await context.close();
}

// --- Administrator ----------------------------------------------------------
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await signIn(context, 'admin@birgma.test');

  await nav(page, 'Consolidation');
  await page.waitForTimeout(1600);
  await shot(page, '30-admin-consolidation');

  await nav(page, 'Data governance');
  await page.waitForTimeout(1400);
  await shot(page, '31-admin-governance');

  await nav(page, 'Operations');
  await page.waitForTimeout(1000);
  await shot(page, '32-admin-operations');

  await page.getByRole('button', { name: 'Run backup now', exact: true }).click();
  await page.waitForTimeout(6000);
  await shot(page, '33-admin-backup-complete');

  // Light theme, on a data-rich screen so the palette is visible.
  await nav(page, 'Consolidation');
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: 'Light theme', exact: true }).click();
  await page.waitForTimeout(900);
  await shot(page, '34-light-theme');

  await context.close();
}

// --- A role with the narrowest scope ---------------------------------------
{
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await signIn(context, 'pmo@birgma.test');
  await shot(page, '40-single-entity-role');
  await context.close();
}

await browser.close();
console.warn('done');

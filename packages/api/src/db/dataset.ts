/**
 * The shape a seed dataset must have, and the two ways of producing one.
 *
 * Both modes converge on `Dataset` before anything touches the database, so the
 * loader has exactly one code path and the two modes cannot drift apart in what
 * they exercise. Which one runs is a deployment choice (`SEED_MODE`), not a
 * code change.
 *
 *   synthetic    Invented from a seeded PRNG. The default, and the only mode
 *                that is safe by construction — there is no input to leak.
 *
 *   anonymised   Read from the artefact produced by `tools/anonymise.ts`. Real
 *                structure, no real content. Useful when the shape matters:
 *                the true distribution of lines across entities and categories
 *                is lumpier than anything a generator produces, which is what
 *                makes NFR-001 performance work and INV-4 reconciliation
 *                meaningful.
 *
 * Neither mode reads `budget-data.js`. The raw extract is Confidential
 * (PRIV-010) and production data must not reach non-production (CMP-104); the
 * anonymised artefact is the only derivative that may.
 */

import { readFile } from 'node:fs/promises';

export type Residency = 'eu' | 'ch' | 'apac' | 'cn';

export interface DatasetEntity {
  code: string;
  name: string;
  currency: string;
  /**
   * ISO 3166-1 alpha-2. The residency bucket is *not* carried here: it follows
   * from the country through `countries` (migration 011), and the seed reads it
   * from there. One fact in the fixture means the fixture cannot contradict the
   * reference table.
   */
  country: string;
}

export interface DatasetCategory {
  name: string;
  costType: 'opex' | 'capex';
}

export interface DatasetLine {
  entityCode: string;
  categoryName: string;
  name: string;
  vendor: string | null;
  currency: string;
  /** Decimal strings, one per quarter, in the line's own currency. */
  quarters: string[];
}

export interface Dataset {
  /** Recorded in the seed's audit event so an environment can say where its data came from. */
  provenance: string;
  entities: DatasetEntity[];
  categories: DatasetCategory[];
  lines: DatasetLine[];
  /** Currency -> EUR per unit, as a decimal string. */
  fx: Record<string, string>;
}

export type SeedMode = 'synthetic' | 'anonymised';

// ---------------------------------------------------------------------------
// Synthetic
// ---------------------------------------------------------------------------

const CATEGORIES: DatasetCategory[] = [
  { name: 'Travel expenses', costType: 'opex' },
  { name: 'Consultancies', costType: 'opex' },
  { name: 'Computer communication / internet', costType: 'opex' },
  { name: 'Short term equipment', costType: 'opex' },
  { name: 'Training', costType: 'opex' },
  { name: 'Licenses', costType: 'opex' },
  { name: 'Other', costType: 'opex' },
  { name: 'Investments', costType: 'capex' },
];

const ENTITIES: DatasetEntity[] = [
  { code: 'NORD-INF', name: 'Nordic Infrastructure', currency: 'EUR', country: 'SE' },
  { code: 'NORD-SEC', name: 'Nordic Security', currency: 'EUR', country: 'SE' },
  { code: 'NORD-DEV', name: 'Nordic Development', currency: 'EUR', country: 'SE' },
  { code: 'SE-RETAIL', name: 'Sweden Retail IT', currency: 'SEK', country: 'SE' },
  { code: 'SE-DEV', name: 'Sweden Development', currency: 'SEK', country: 'SE' },
  { code: 'SE-STORES', name: 'Sweden Store Systems', currency: 'SEK', country: 'SE' },
  { code: 'NO-RETAIL', name: 'Norway Retail IT', currency: 'NOK', country: 'NO' },
  { code: 'DK-RETAIL', name: 'Denmark Retail IT', currency: 'DKK', country: 'DK' },
  { code: 'FI-RETAIL', name: 'Finland Retail IT', currency: 'EUR', country: 'FI' },
  { code: 'EU-LOG', name: 'European Logistics IT', currency: 'EUR', country: 'NL' },
  { code: 'EU-ECOM', name: 'European E-commerce', currency: 'EUR', country: 'NL' },
  { code: 'EU-DATA', name: 'European Data Platform', currency: 'EUR', country: 'DE' },
  { code: 'EU-WORK', name: 'European Workplace', currency: 'EUR', country: 'DE' },
  { code: 'EU-NET', name: 'European Network', currency: 'EUR', country: 'DE' },
  { code: 'CH-GROUP', name: 'Switzerland Group IT', currency: 'CHF', country: 'CH' },
  { code: 'CH-SEC', name: 'Switzerland Security', currency: 'CHF', country: 'CH' },
  { code: 'APAC-HUB', name: 'APAC Hub IT', currency: 'SGD', country: 'SG' },
  { code: 'APAC-SRC', name: 'APAC Sourcing IT', currency: 'USD', country: 'SG' },
  { code: 'IN-DEV', name: 'India Development Centre', currency: 'INR', country: 'IN' },
  { code: 'VN-OPS', name: 'Vietnam Operations IT', currency: 'VND', country: 'VN' },
  // CMP-140: mainland China cannot share the EU tenant. The row exists so the
  // residency guard is exercised; an EU deployment must never return it.
  { code: 'CN-SRC', name: 'China Sourcing IT', currency: 'CNY', country: 'CN' },
];

/** Indicative FY rates. Real rates are administered in-app (FR-014). */
export const SYNTHETIC_FX: Record<string, string> = {
  EUR: '1', SEK: '0.087', NOK: '0.0858', DKK: '0.134', CHF: '1.06',
  GBP: '1.149', USD: '0.92', PLN: '0.233', TRY: '0.026', CZK: '0.0396',
  INR: '0.0110', CNY: '0.1198', HKD: '0.1096', TWD: '0.0286', VND: '0.0000363',
  IDR: '0.0000584', THB: '0.0261', MYR: '0.2027', PHP: '0.0161', SGD: '0.685',
  JPY: '0.0058', KRW: '0.000607', BDT: '0.00706', LKR: '0.00305', LAK: '0.0000396',
  AUD: '0.60', ILS: '0.2574',
};

const VENDOR_STEMS = [
  'Northwind', 'Contoso', 'Fabrikam', 'Litware', 'Proseware', 'Adventure',
  'Tailspin', 'Wingtip', 'Woodgrove', 'Lucerne', 'Trey', 'Alpine',
];

const LINE_STEMS: Record<string, string[]> = {
  'Travel expenses': ['Regional site visits', 'Vendor summit travel', 'Team offsite travel'],
  Consultancies: ['Integration partner', 'Security operations partner', 'Platform partner', 'Advisory retainer'],
  'Computer communication / internet': ['Dark fibre link', 'Office ISP link', 'SD-WAN service', 'Managed connectivity'],
  'Short term equipment': ['Workstation replacement', 'Screen replacement', 'Peripherals and cabling', 'Mobile handsets'],
  Training: ['Certification programme', 'Platform training', 'Security awareness'],
  Licenses: ['Collaboration suite', 'Endpoint protection', 'Database licensing', 'Monitoring platform', 'Virtualisation'],
  Other: ['Contingency', 'Shared services recharge'],
  Investments: ['Network refresh', 'Datacentre hardware', 'Store systems rollout'],
};

/**
 * Deterministic pseudo-random generator. Seeded so the fixture is identical on
 * every run: a flaky seed makes a failing reconciliation test unreproducible.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function syntheticDataset(): Dataset {
  const rng = makeRng(20260815);
  const lines: DatasetLine[] = [];

  for (const entity of ENTITIES) {
    for (const category of CATEGORIES) {
      const stems = LINE_STEMS[category.name] ?? ['Line'];
      for (const stem of stems) {
        const base = 5_000 + Math.floor(rng() * 120_000);
        lines.push({
          entityCode: entity.code,
          categoryName: category.name,
          name: `${stem} — ${entity.code}`,
          vendor: `${VENDOR_STEMS[Math.floor(rng() * VENDOR_STEMS.length)]} Systems`,
          currency: entity.currency,
          quarters: Array.from({ length: 4 }, () =>
            String(Math.round(base * (0.85 + rng() * 0.3))),
          ),
        });
      }
    }
  }

  return {
    provenance: 'synthetic (PRIV-010: invented, no real data)',
    entities: ENTITIES,
    categories: CATEGORIES,
    lines,
    fx: SYNTHETIC_FX,
  };
}

// ---------------------------------------------------------------------------
// Anonymised
// ---------------------------------------------------------------------------

interface AnonymisedFile {
  meta: {
    method: string;
    jitterPercent: number;
    roundingUnit: number;
    entityCount: number;
    lineCount: number;
    singletonClasses: string[];
  };
  entities: DatasetEntity[];
  categories: DatasetCategory[];
  lines: Omit<DatasetLine, 'vendor'>[];
  fx: Record<string, string>;
}

export async function anonymisedDataset(file: string): Promise<Dataset> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(
      `SEED_MODE=anonymised needs ${file}, which does not exist.\n` +
      'Generate it with:\n' +
      '  node --experimental-strip-types tools/anonymise.ts --in design/budget-data.js --out ' + file,
    );
  }

  const parsed = JSON.parse(raw) as AnonymisedFile;
  if (parsed.meta?.method !== 'anonymised') {
    // Refuse anything that is not a recognised anonymiser output. The failure
    // mode this prevents is someone pointing SEED_MODE at the raw extract.
    throw new Error(`${file} is not an anonymiser output (meta.method missing)`);
  }

  // The artefact is committed and the schema is not frozen, so the two drift:
  // migration 011 replaced `residency` with `country` on a dataset entity, and
  // a fixture generated before it parses cleanly, satisfies `meta.method`, and
  // then fails deep inside the seed with a null dereference naming nothing.
  // Checking the shape here turns that into a sentence with the remedy in it.
  const stale = parsed.entities.filter((e) => typeof e.country !== 'string');
  if (stale.length > 0) {
    throw new Error(
      `${file} predates migration 011: ${stale.length} of ${parsed.entities.length} ` +
        'entities have no country. Regenerate it with:\n' +
        '  node --experimental-strip-types tools/anonymise.ts --in design/budget-data.js --out ' +
        file,
    );
  }

  return {
    provenance:
      `anonymised (jitter ±${parsed.meta.jitterPercent}%, rounded to ${parsed.meta.roundingUnit}, ` +
      `${parsed.meta.singletonClasses.length} structurally unique entities)`,
    entities: parsed.entities,
    categories: parsed.categories,
    // The source workbook has no vendor column — vendor names were embedded in
    // line names, which the anonymiser discards. Nothing is invented here to
    // fill the gap; an absent field is more honest than a plausible one.
    lines: parsed.lines.map((line) => ({ ...line, vendor: null })),
    fx: parsed.fx,
  };
}

export async function loadDataset(mode: SeedMode, anonymisedFile: string): Promise<Dataset> {
  return mode === 'anonymised' ? anonymisedDataset(anonymisedFile) : syntheticDataset();
}

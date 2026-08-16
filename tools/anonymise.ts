/**
 * Anonymisation tool for the FY2026 workbook extract.
 *
 * Deliberately a standalone offline tool, not part of the application. The API
 * and the seeder never read `budget-data.js`; they read the artefact this tool
 * produces. That separation is the point — it means "did production data reach
 * a non-production database" has a single, checkable answer (CMP-104,
 * PRIV-010), and CI can keep refusing any import of the raw extract from
 * `packages/`.
 *
 *     node --experimental-strip-types tools/anonymise.ts \
 *       --in design/budget-data.js --out db/fixtures/anonymised.json
 *
 * ---------------------------------------------------------------------------
 * WHAT SURVIVES, AND WHY
 * ---------------------------------------------------------------------------
 * The reason to anonymise rather than synthesise is *shape fidelity*: the real
 * workbook has an uneven distribution of lines across entities and categories,
 * a real currency mix, and real amount magnitudes. Those drive NFR-001
 * performance work and make the INV-4 reconciliation property meaningful.
 *
 *   Preserved   entity count; categories per entity; lines per category;
 *               currency distribution; amount magnitude and quarterly phasing
 *               shape; the FX table (market data, not confidential).
 *
 *   Destroyed   entity codes and names; every line name; all free text; exact
 *               amounts; and the ordering that would let a reader align row N
 *               of the output with row N of the source.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR RE-IDENTIFICATION ROUTES THIS ADDRESSES
 * ---------------------------------------------------------------------------
 * 1. Direct identifiers. Line names in the source carry vendor names
 *    ("Partner <vendor>") and, in the Training category, the given names of
 *    identifiable employees. Pseudonymising these is not enough — a consistent
 *    pseudonym still supports linkage — so names are *discarded* and replaced
 *    with a generic label drawn from the category.
 *
 * 2. Quasi-identifiers. An exact contract value is as identifying as a name to
 *    anyone who knows the market: "the 83,000 EUR connectivity line" is one
 *    supplier. Amounts are jittered by a bounded random proportion and then
 *    rounded, so magnitude survives and exact-value matching does not.
 *
 * 3. Positional linkage. If output order matched input order, every mitigation
 *    above would be undone by counting rows. Entities and lines are shuffled.
 *
 * 4. Singling out by structure. An entity that is unique on (currency,
 *    category count, line-count band) is re-identifiable from its shape alone,
 *    however well its contents are scrubbed. The tool cannot fix this without
 *    destroying the utility it exists to preserve, so instead it *reports* it:
 *    the k-anonymity summary names every equivalence class of size 1. Read it.
 *
 * ---------------------------------------------------------------------------
 * KEYING
 * ---------------------------------------------------------------------------
 * By default a random key is generated per run and discarded when the process
 * exits, so no mapping back to the source exists anywhere. `--key` makes a run
 * reproducible, which is useful for a stable fixture, at the cost that anyone
 * holding the key can relink the output to the source. The default is the safe
 * one on purpose.
 *
 * Note what is NOT written to the output: no hash or fingerprint of the source
 * data. A digest would let someone confirm a guess about which workbook this
 * came from, which is the same disclosure by a longer route.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Source shape
// ---------------------------------------------------------------------------

interface SourceItem {
  name: string;
  cur: string;
  q: number[];
}
interface SourceCategory {
  name: string;
  items: SourceItem[];
}
interface SourceUnit {
  code: string;
  title: string;
  cats: SourceCategory[];
}
interface SourceData {
  units: SourceUnit[];
  fx: Record<string, number>;
  comments?: string[];
}

// ---------------------------------------------------------------------------
// Output shape — this is what the seeder consumes
// ---------------------------------------------------------------------------

export interface AnonymisedFixture {
  meta: {
    generatedAt: string;
    method: 'anonymised';
    jitterPercent: number;
    roundingUnit: number;
    entityCount: number;
    lineCount: number;
    /** Equivalence classes of size 1 — see route 4 above. */
    singletonClasses: string[];
  };
  entities: { code: string; name: string; currency: string; residency: Residency }[];
  categories: { name: string; costType: 'opex' | 'capex' }[];
  lines: {
    entityCode: string;
    categoryName: string;
    name: string;
    currency: string;
    /** Decimal strings, already jittered and rounded. */
    quarters: string[];
  }[];
  fx: Record<string, string>;
}

type Residency = 'eu' | 'ch' | 'apac' | 'cn';

/**
 * SPEC §9.4. Residency is not in the source workbook, so it is derived from the
 * line currency — the best available proxy, and conservative: anything not
 * recognised as European lands in `apac`, never in `eu`.
 */
const RESIDENCY_BY_CURRENCY: Record<string, Residency> = {
  EUR: 'eu', SEK: 'eu', NOK: 'eu', DKK: 'eu', PLN: 'eu', CZK: 'eu', GBP: 'eu',
  CHF: 'ch',
  CNY: 'cn',
  USD: 'apac', INR: 'apac', VND: 'apac', HKD: 'apac', TWD: 'apac', IDR: 'apac',
  THB: 'apac', MYR: 'apac', PHP: 'apac', SGD: 'apac', JPY: 'apac', KRW: 'apac',
  BDT: 'apac', LKR: 'apac', LAK: 'apac', AUD: 'apac', ILS: 'apac', TRY: 'eu',
};

/**
 * Generic line labels per category. The source names are discarded, not
 * transformed — see route 1. Where a category is unrecognised the label falls
 * back to the category name itself, which is admin-defined and not sensitive.
 */
const LINE_LABELS: Record<string, string[]> = {
  'Travel expenses': ['Regional travel', 'Vendor meetings', 'Team travel', 'Site visits'],
  Consultancies: ['Delivery partner', 'Advisory partner', 'Managed service partner', 'Specialist contractor'],
  'Computer communication / internet': ['Connectivity link', 'Managed network service', 'Office internet', 'Backbone capacity'],
  'Short term equipment': ['Workstation refresh', 'Peripherals', 'Mobile devices', 'Display refresh'],
  Training: ['Certification', 'Platform training', 'Skills programme', 'Security awareness'],
  Licenses: ['Productivity licensing', 'Security licensing', 'Database licensing', 'Monitoring licensing'],
  Other: ['Contingency', 'Shared services recharge', 'Miscellaneous operating cost'],
  Investments: ['Infrastructure refresh', 'Platform investment', 'Store systems investment'],
};

const CAPEX_CATEGORIES = new Set(['Investments']);

// ---------------------------------------------------------------------------
// Deterministic, keyed randomness
// ---------------------------------------------------------------------------

/**
 * A keyed PRNG. Derived from an HMAC so that the same key and label always give
 * the same stream — reproducible when a key is supplied, unlinkable when it is
 * not, because the key is thrown away.
 */
function keyedRandom(key: Buffer, label: string): () => number {
  let counter = 0;
  let pool = Buffer.alloc(0);
  let offset = 0;

  return () => {
    if (offset + 4 > pool.length) {
      pool = createHmac('sha256', key).update(`${label}:${counter}`).digest();
      counter += 1;
      offset = 0;
    }
    const value = pool.readUInt32BE(offset);
    offset += 4;
    return value / 0x1_0000_0000;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Jitter an amount by up to ±`jitterPercent`, then round to `roundingUnit`.
 *
 * Both steps matter. Jitter alone leaves a value that is still "close enough"
 * to match against a known figure; rounding alone is reversible if the original
 * granularity is known. Together they leave magnitude intact and exact matching
 * useless. Zero stays zero — a line with no spend in a quarter is structural,
 * not a value worth hiding, and inventing spend would corrupt the phasing shape.
 */
function perturb(
  amount: number,
  random: () => number,
  jitterPercent: number,
  roundingUnit: number,
): string {
  if (!Number.isFinite(amount) || amount === 0) return '0';
  const factor = 1 + (random() * 2 - 1) * (jitterPercent / 100);
  const jittered = amount * factor;
  const rounded = Math.round(jittered / roundingUnit) * roundingUnit;
  // Never round a real cost away to nothing; that would change the line's
  // meaning from "small" to "absent".
  const floored = rounded === 0 ? roundingUnit : rounded;
  return String(floored);
}

// ---------------------------------------------------------------------------
// k-anonymity reporting
// ---------------------------------------------------------------------------

/**
 * Groups entities into equivalence classes on the quasi-identifiers a reader
 * could observe in the output, and returns the classes containing exactly one
 * entity. Those entities are singled out by their shape regardless of how well
 * their contents were scrubbed.
 */
function singletonClasses(units: SourceUnit[]): string[] {
  const classes = new Map<string, number>();

  for (const unit of units) {
    const currencies = new Set(unit.cats.flatMap((c) => c.items.map((i) => i.cur)));
    const lineCount = unit.cats.reduce((n, c) => n + c.items.length, 0);
    // Banded, not exact: an exact line count is itself a quasi-identifier.
    const band = lineCount <= 10 ? 'small' : lineCount <= 30 ? 'medium' : 'large';
    const key = `currencies=${[...currencies].sort().join('+')} categories=${unit.cats.length} size=${band}`;
    classes.set(key, (classes.get(key) ?? 0) + 1);
  }

  return [...classes].filter(([, count]) => count === 1).map(([key]) => key);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface AnonymiseOptions {
  jitterPercent?: number;
  roundingUnit?: number;
  /** Hex key for a reproducible run. Omit for an unlinkable one. */
  key?: string;
}

export function anonymise(source: SourceData, options: AnonymiseOptions = {}): AnonymisedFixture {
  const jitterPercent = options.jitterPercent ?? 7;
  const roundingUnit = options.roundingUnit ?? 100;
  const key = options.key ? Buffer.from(options.key, 'hex') : randomBytes(32);

  const structureRandom = keyedRandom(key, 'structure');
  const amountRandom = keyedRandom(key, 'amounts');

  // Shuffle before numbering, so the sequence carries no positional information.
  const units = shuffle(source.units, structureRandom);

  const entities: AnonymisedFixture['entities'] = [];
  const lines: AnonymisedFixture['lines'] = [];
  const categoryNames = new Set<string>();

  units.forEach((unit, index) => {
    const code = `ENT-${String(index + 1).padStart(2, '0')}`;

    // The entity's currency is the one most of its lines use.
    const tally = new Map<string, number>();
    for (const cat of unit.cats) {
      for (const item of cat.items) tally.set(item.cur, (tally.get(item.cur) ?? 0) + 1);
    }
    const currency = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'EUR';

    entities.push({
      code,
      // No relationship to the source title, which names real business units.
      name: `Business unit ${index + 1}`,
      currency,
      residency: RESIDENCY_BY_CURRENCY[currency] ?? 'apac',
    });

    for (const cat of unit.cats) {
      categoryNames.add(cat.name);
      const labels = LINE_LABELS[cat.name] ?? [cat.name];

      shuffle(cat.items, structureRandom).forEach((item, itemIndex) => {
        lines.push({
          entityCode: code,
          categoryName: cat.name,
          // Discarded and replaced, never transformed — the source name may
          // contain a vendor or a person.
          name: `${labels[itemIndex % labels.length]} ${itemIndex + 1}`,
          currency: item.cur,
          quarters: item.q.map((amount) =>
            perturb(amount, amountRandom, jitterPercent, roundingUnit),
          ),
        });
      });
    }
  });

  // Category names are admin-defined cost categories, not sensitive, and the
  // spec fixes them as the visual contract — so they are carried across.
  const categories = [...categoryNames].map((name) => ({
    name,
    costType: (CAPEX_CATEGORIES.has(name) ? 'capex' : 'opex') as 'opex' | 'capex',
  }));

  const fx: Record<string, string> = {};
  for (const [currency, rate] of Object.entries(source.fx ?? {})) {
    // Market rates are public information, so they pass through unmodified —
    // and they must, or FX conversion tests would be meaningless.
    fx[currency] = rate.toFixed(8);
  }
  fx.EUR = '1.00000000';

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      method: 'anonymised',
      jitterPercent,
      roundingUnit,
      entityCount: entities.length,
      lineCount: lines.length,
      singletonClasses: singletonClasses(source.units),
    },
    entities,
    categories,
    lines,
    fx,
  };
}

/**
 * Loads `budget-data.js`, which is an ES module exporting `DATA`. Parsed by
 * stripping the export keyword and evaluating the object literal — there is no
 * executable code in the file, only data.
 */
async function loadSource(file: string): Promise<SourceData> {
  const text = await readFile(file, 'utf8');
  const match = text.match(/export\s+const\s+DATA\s*=\s*([\s\S]*?);?\s*$/);
  if (!match?.[1]) throw new Error(`could not find "export const DATA" in ${file}`);
  return JSON.parse(match[1]) as SourceData;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    out[name!] = inline ?? argv[++i] ?? '';
  }
  return out;
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isEntrypoint) {
  const args = parseArgs(process.argv.slice(2));
  const input = args.in ?? 'design/budget-data.js';
  const output = args.out ?? 'db/fixtures/anonymised.json';

  const source = await loadSource(input);
  const fixture = anonymise(source, {
    jitterPercent: args.jitter ? Number(args.jitter) : undefined,
    roundingUnit: args.rounding ? Number(args.rounding) : undefined,
    key: args.key,
  });

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

  console.warn(`anonymised ${fixture.meta.entityCount} entities / ${fixture.meta.lineCount} lines -> ${output}`);
  console.warn(`  amounts jittered +/-${fixture.meta.jitterPercent}% and rounded to ${fixture.meta.roundingUnit}`);
  console.warn(`  line names, entity names and all free text discarded`);

  if (args.key) {
    console.warn(
      '\n  WARNING: a fixed key was supplied. This run is reproducible, which also\n' +
      '  means anyone holding the key can relink the output to the source. Omit\n' +
      '  --key for an unlinkable run.',
    );
  }

  if (fixture.meta.singletonClasses.length > 0) {
    console.warn(
      `\n  ${fixture.meta.singletonClasses.length} entity/entities are unique on their observable shape\n` +
      '  (currency mix, category count, size band) and can be singled out from\n' +
      '  structure alone. Scrubbing content does not fix this. Review before\n' +
      '  treating the output as anonymous rather than pseudonymous:',
    );
    for (const klass of fixture.meta.singletonClasses) console.warn(`    - ${klass}`);
  }

  console.warn(
    '\n  Treat the output as Internal, not Public. It is derived from Confidential\n' +
    '  data and is not committed to the repository by default.',
  );
}

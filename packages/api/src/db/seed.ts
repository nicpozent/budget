/**
 * Development and test seed.
 *
 * PRIV-010: this data is SYNTHETIC. It deliberately does not read
 * `budget-data.js`, which is the real FY2026 workbook extract and is classified
 * Confidential — it carries live vendor names, contract values and, in the
 * training lines, named individuals. Seeding a development database from it
 * would put production commercial and personal data into non-production, which
 * is the specific thing PRIV-010 and CMP-104 prohibit.
 *
 * What is reproduced is the *shape*: 21 entities, the same eight categories,
 * a comparable line count and currency spread, so that performance work
 * (NFR-001) and the reconciliation property tests (NFR-004) are exercised
 * against realistic volume.
 */

import path from 'node:path';
import { createDb, sql, type Db } from './pool.ts';

const CATEGORIES = [
  { name: 'Travel expenses', costType: 'opex' },
  { name: 'Consultancies', costType: 'opex' },
  { name: 'Computer communication / internet', costType: 'opex' },
  { name: 'Short term equipment', costType: 'opex' },
  { name: 'Training', costType: 'opex' },
  { name: 'Licenses', costType: 'opex' },
  { name: 'Other', costType: 'opex' },
  { name: 'Investments', costType: 'capex' },
] as const;

/** Entity codes mirror the workbook's naming pattern without reusing its names. */
const ENTITIES: { code: string; name: string; currency: string; residency: string }[] = [
  { code: 'NORD-INF', name: 'Nordic Infrastructure', currency: 'EUR', residency: 'eu' },
  { code: 'NORD-SEC', name: 'Nordic Security', currency: 'EUR', residency: 'eu' },
  { code: 'NORD-DEV', name: 'Nordic Development', currency: 'EUR', residency: 'eu' },
  { code: 'SE-RETAIL', name: 'Sweden Retail IT', currency: 'SEK', residency: 'eu' },
  { code: 'SE-DEV', name: 'Sweden Development', currency: 'SEK', residency: 'eu' },
  { code: 'SE-STORES', name: 'Sweden Store Systems', currency: 'SEK', residency: 'eu' },
  { code: 'NO-RETAIL', name: 'Norway Retail IT', currency: 'NOK', residency: 'eu' },
  { code: 'DK-RETAIL', name: 'Denmark Retail IT', currency: 'DKK', residency: 'eu' },
  { code: 'FI-RETAIL', name: 'Finland Retail IT', currency: 'EUR', residency: 'eu' },
  { code: 'EU-LOG', name: 'European Logistics IT', currency: 'EUR', residency: 'eu' },
  { code: 'EU-ECOM', name: 'European E-commerce', currency: 'EUR', residency: 'eu' },
  { code: 'EU-DATA', name: 'European Data Platform', currency: 'EUR', residency: 'eu' },
  { code: 'EU-WORK', name: 'European Workplace', currency: 'EUR', residency: 'eu' },
  { code: 'EU-NET', name: 'European Network', currency: 'EUR', residency: 'eu' },
  { code: 'CH-GROUP', name: 'Switzerland Group IT', currency: 'CHF', residency: 'ch' },
  { code: 'CH-SEC', name: 'Switzerland Security', currency: 'CHF', residency: 'ch' },
  { code: 'APAC-HUB', name: 'APAC Hub IT', currency: 'SGD', residency: 'apac' },
  { code: 'APAC-SRC', name: 'APAC Sourcing IT', currency: 'USD', residency: 'apac' },
  { code: 'IN-DEV', name: 'India Development Centre', currency: 'INR', residency: 'apac' },
  { code: 'VN-OPS', name: 'Vietnam Operations IT', currency: 'VND', residency: 'apac' },
  // CMP-140: mainland China cannot share the EU tenant. The row exists so the
  // residency guard is exercised; an EU deployment must never return it.
  { code: 'CN-SRC', name: 'China Sourcing IT', currency: 'CNY', residency: 'cn' },
];

/** Indicative FY rates. Real rates are administered in-app (FR-014). */
const FX: Record<string, string> = {
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
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const USERS = [
  { email: 'admin@birgma.test', name: 'Group IT Finance', role: 'admin' },
  { email: 'cfo@birgma.test', name: 'Group CFO', role: 'cfo' },
  { email: 'finance@birgma.test', name: 'Finance Manager', role: 'finance_manager' },
  { email: 'cio@birgma.test', name: 'Group CIO', role: 'cio' },
  { email: 'cto@birgma.test', name: 'Group CTO', role: 'cto' },
  { email: 'infra@birgma.test', name: 'Global Infrastructure Manager', role: 'infra_manager' },
  { email: 'security@birgma.test', name: 'Security Manager', role: 'security_manager' },
  { email: 'architecture@birgma.test', name: 'Architecture Manager', role: 'arch_manager' },
  { email: 'pmo@birgma.test', name: 'PMO Lead', role: 'pmo' },
];

const VALIDATION_RULES = [
  { code: 'cost_centre_required', description: 'Every line must have a cost centre', severity: 'blocking' },
  { code: 'cost_centre_approved', description: 'Cost centre must be approved', severity: 'blocking' },
  { code: 'no_zero_lines', description: 'Lines must carry a non-zero plan', severity: 'warning' },
  { code: 'justification_above_threshold', description: 'Lines above the approval threshold need a justification', severity: 'warning' },
  { code: 'capex_asset_life_approved', description: 'Capex lines need an approved asset life', severity: 'warning' },
];

const CLASSIFICATIONS: { fieldKey: string; dataClass: string }[] = [
  { fieldKey: 'line_item.name', dataClass: 'internal' },
  { fieldKey: 'line_item.vendor', dataClass: 'confidential' },
  { fieldKey: 'line_item.justification', dataClass: 'confidential' },
  { fieldKey: 'period_amount.amount', dataClass: 'confidential' },
  { fieldKey: 'line_comment.body', dataClass: 'personal_data' },
  { fieldKey: 'user.email', dataClass: 'personal_data' },
  { fieldKey: 'user.display_name', dataClass: 'personal_data' },
  { fieldKey: 'audit_event.actor_user_id', dataClass: 'personal_data' },
  { fieldKey: 'driver.value', dataClass: 'confidential' },
  { fieldKey: 'entity.code', dataClass: 'internal' },
];

/** SPEC §9.2 defaults. */
const RETENTION = [
  { dataset: 'audit', months: 84 },
  { dataset: 'budget', months: 120 },
  { dataset: 'free_text', months: 36 },
  { dataset: 'inactive_users', months: 24 },
];

export interface SeedResult {
  fiscalYear: number;
  entityIds: string[];
  lineCount: number;
}

export async function seed(db: Db, fiscalYear: number): Promise<SeedResult> {
  const rng = makeRng(20260815);

  return db.transaction(async (tx) => {
    // Users
    const userIds = new Map<string, string>();
    for (const user of USERS) {
      const row = await tx.one<{ id: string }>(sql`
        insert into users (email, display_name, role, entra_oid)
        values (${user.email}, ${user.name}, ${user.role}, ${`dev:${user.email}`})
        on conflict (email) do update set display_name = excluded.display_name
        returning id
      `);
      userIds.set(user.email, row!.id);
    }
    const adminId = userIds.get('admin@birgma.test')!;
    const cfoId = userIds.get('cfo@birgma.test')!;

    // Cycle
    await tx.query(sql`
      insert into cycles (fiscal_year, phase, granularity, approval_threshold_eur)
      values (${fiscalYear}, 'collection', 'quarterly', 50000)
      on conflict (fiscal_year) do nothing
    `);

    // FX for the current and four prior years, so the trend has data.
    for (const [currency, rate] of Object.entries(FX)) {
      for (let y = fiscalYear - 4; y <= fiscalYear; y += 1) {
        // Drift the historical rates slightly so FR-063 volatility is non-trivial.
        const drift = 1 + (y - fiscalYear) * 0.015;
        const adjusted = (Number(rate) * drift).toFixed(8);
        await tx.query(sql`
          insert into fx_rates (currency, fiscal_year, rate, updated_by)
          values (${currency}, ${y}, ${adjusted}, ${adminId})
          on conflict (currency, fiscal_year) do nothing
        `);
      }
    }

    // Categories
    const categoryIds: string[] = [];
    for (const [i, category] of CATEGORIES.entries()) {
      const row = await tx.one<{ id: string }>(sql`
        insert into categories (name, cost_type, position)
        values (${category.name}, ${category.costType}, ${i})
        on conflict (name) do update set position = excluded.position
        returning id
      `);
      categoryIds.push(row!.id);
    }

    // Cost centres. SEC-012 means the approver is a different actor from the
    // creator, so the seed models that rather than short-circuiting it.
    const costCentreIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const status = i < 9 ? 'approved' : i < 11 ? 'pending' : 'rejected';
      const row = await tx.one<{ id: string }>(sql`
        insert into cost_centres (code, description, status, created_by, approved_by, decided_at)
        values (
          ${`CC-${String(1000 + i)}`},
          ${`Cost centre ${1000 + i}`},
          ${status},
          ${adminId},
          ${status === 'pending' ? null : cfoId},
          ${status === 'pending' ? null : new Date()}
        )
        on conflict (code) do nothing
        returning id
      `);
      if (row) costCentreIds.push(row.id);
    }
    const approvedCentres = costCentreIds.slice(0, 9);

    // Validation rules
    for (const rule of VALIDATION_RULES) {
      await tx.query(sql`
        insert into validation_rules (code, description, severity)
        values (${rule.code}, ${rule.description}, ${rule.severity})
        on conflict (code) do nothing
      `);
    }

    // Template fields
    const FIELDS = [
      { key: 'name', label: 'Line', type: 'text', required: true, visible: true },
      { key: 'vendor', label: 'Vendor', type: 'text', required: false, visible: true },
      { key: 'cost_centre', label: 'Cost centre', type: 'select', required: true, visible: true },
      { key: 'gl_account', label: 'GL account', type: 'text', required: false, visible: false },
      { key: 'justification', label: 'Justification', type: 'note', required: false, visible: false },
    ];
    for (const [i, field] of FIELDS.entries()) {
      await tx.query(sql`
        insert into template_fields (fiscal_year, field_key, label, field_type, required, visible, position)
        values (${fiscalYear}, ${field.key}, ${field.label}, ${field.type},
                ${field.required}, ${field.visible}, ${i})
        on conflict (fiscal_year, field_key) do nothing
      `);
    }

    // Governance defaults
    for (const c of CLASSIFICATIONS) {
      await tx.query(sql`
        insert into data_classifications (field_key, data_class, updated_by)
        values (${c.fieldKey}, ${c.dataClass}, ${adminId})
        on conflict (field_key) do nothing
      `);
    }
    for (const r of RETENTION) {
      await tx.query(sql`
        insert into retention_policies (dataset, months, updated_by)
        values (${r.dataset}, ${r.months}, ${adminId})
        on conflict (dataset) do nothing
      `);
    }

    // Entities, owners, drivers, lines
    const managerEmails = [
      'finance@birgma.test', 'cio@birgma.test', 'cto@birgma.test',
      'infra@birgma.test', 'security@birgma.test', 'architecture@birgma.test',
      'pmo@birgma.test',
    ];

    const entityIds: string[] = [];
    let lineCount = 0;

    for (const [index, entity] of ENTITIES.entries()) {
      const row = await tx.one<{ id: string }>(sql`
        insert into entities (code, name, currency, residency, deadline, state)
        values (${entity.code}, ${entity.name}, ${entity.currency}, ${entity.residency},
                ${`${fiscalYear - 1}-11-30`}, 'draft')
        on conflict (code) do update set name = excluded.name
        returning id
      `);
      const entityId = row!.id;
      entityIds.push(entityId);

      const ownerEmail = managerEmails[index % managerEmails.length]!;
      await tx.query(sql`
        insert into entity_owners (entity_id, user_id)
        values (${entityId}, ${userIds.get(ownerEmail)!})
        on conflict do nothing
      `);

      for (const driverKey of ['headcount', 'sites', 'devices', 'stores'] as const) {
        const value = 10 + Math.floor(rng() * 400);
        await tx.query(sql`
          insert into drivers (entity_id, driver_key, unit, value, fiscal_year)
          values (${entityId}, ${driverKey}, ${driverKey}, ${value}, ${fiscalYear})
          on conflict (entity_id, driver_key, fiscal_year) do nothing
        `);
      }

      for (const [ci, category] of CATEGORIES.entries()) {
        const stems = LINE_STEMS[category.name] ?? ['Line'];
        for (const stem of stems) {
          const vendor = `${VENDOR_STEMS[Math.floor(rng() * VENDOR_STEMS.length)]} Systems`;
          const isCapex = category.costType === 'capex';
          const lineRow = await tx.one<{ id: string }>(sql`
            insert into line_items (
              entity_id, category_id, name, vendor, cost_centre_id, gl_account,
              cost_type, currency, justification, asset_life_years, asset_life_status
            ) values (
              ${entityId}, ${categoryIds[ci]!}, ${`${stem} — ${entity.code}`}, ${vendor},
              ${approvedCentres[Math.floor(rng() * approvedCentres.length)]!},
              ${`GL${4000 + ci}`},
              ${category.costType}, ${entity.currency},
              ${rng() > 0.6 ? `Planned ${stem.toLowerCase()} for ${entity.name}.` : null},
              ${isCapex ? 3 + Math.floor(rng() * 3) : null},
              ${isCapex ? 'approved' : null}
            ) returning id
          `);
          lineCount += 1;

          // Five years of quarterly plans, so the trend and variance reports
          // have real data to fold rather than a synthesised parent series.
          const base = 5_000 + Math.floor(rng() * 120_000);
          const growth = 0.94 + rng() * 0.16;
          for (let y = fiscalYear - 4; y <= fiscalYear; y += 1) {
            const yearFactor = growth ** (y - fiscalYear);
            for (let period = 1; period <= 4; period += 1) {
              const amount = Math.round(base * yearFactor * (0.85 + rng() * 0.3));
              await tx.query(sql`
                insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
                values (${lineRow!.id}, ${y}, ${period}, 'working', ${String(amount)})
                on conflict (line_id, fiscal_year, period, budget_version) do nothing
              `);
            }
          }

          // Recorded spend for elapsed quarters only (FR-041).
          for (let period = 1; period <= 2; period += 1) {
            const spend = Math.round(base * (0.7 + rng() * 0.6));
            await tx.query(sql`
              insert into actuals (line_id, fiscal_year, period, amount, recorded_by)
              values (${lineRow!.id}, ${fiscalYear}, ${period}, ${String(spend)},
                      ${userIds.get(ownerEmail)!})
              on conflict (line_id, fiscal_year, period) do nothing
            `);
          }
        }
      }
    }

    // Allocation pools (FR-023)
    for (const pool of [
      { name: 'Group security operations', amount: '1200000', driver: 'devices' },
      { name: 'Group network backbone', amount: '900000', driver: 'sites' },
      { name: 'Group collaboration licensing', amount: '2400000', driver: 'headcount' },
    ]) {
      await tx.query(sql`
        insert into allocation_pools (name, amount, currency, driver_key, fiscal_year)
        values (${pool.name}, ${pool.amount}, 'EUR', ${pool.driver}, ${fiscalYear})
        on conflict (name, fiscal_year) do nothing
      `);
    }

    return { fiscalYear, entityIds, lineCount };
  });
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isEntrypoint) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }
  const db = createDb({
    DATABASE_URL: url,
    DB_POOL_MAX: 4,
    DB_STATEMENT_TIMEOUT_MS: 30_000,
  });
  const year = Number(process.env.FISCAL_YEAR ?? 2026);
  seed(db, year)
    .then((result) => {
      console.log(
        `seeded FY${result.fiscalYear}: ${result.entityIds.length} entities, ${result.lineCount} lines (synthetic — PRIV-010)`,
      );
      return db.close();
    })
    .catch(async (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      await db.close();
      process.exit(1);
    });
}

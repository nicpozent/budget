/**
 * Seeds a database from a `Dataset`.
 *
 * Which dataset is a deployment choice (`SEED_MODE`), not a code change — see
 * `dataset.ts`. Both modes converge on the same structure before this file runs,
 * so there is one loader and the two modes cannot diverge in what they exercise.
 *
 * PRIV-010 / CMP-104: neither mode reads `budget-data.js`. The raw FY2026
 * extract is Confidential — it carries live vendor names, contract values and
 * the given names of identifiable employees — and production data must not
 * reach non-production. The anonymised artefact from `tools/anonymise.ts` is
 * the only derivative permitted here, and this file refuses anything that is
 * not a recognised anonymiser output.
 */

import path from 'node:path';
import { WORKING_VERSION } from '@spendifre/shared';
import { createDb, sql, type Db } from './pool.ts';
import {
  loadDataset,
  makeRng,
  type Dataset,
  type SeedMode,
} from './dataset.ts';

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

const CLASSIFICATIONS = [
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

const TEMPLATE_FIELDS = [
  { key: 'name', label: 'Line', type: 'text', required: true, visible: true },
  { key: 'vendor', label: 'Vendor', type: 'text', required: false, visible: true },
  { key: 'cost_centre', label: 'Cost centre', type: 'select', required: true, visible: true },
  { key: 'gl_account', label: 'GL account', type: 'text', required: false, visible: false },
  { key: 'justification', label: 'Justification', type: 'note', required: false, visible: false },
];

const MANAGER_EMAILS = [
  'finance@birgma.test', 'cio@birgma.test', 'cto@birgma.test',
  'infra@birgma.test', 'security@birgma.test', 'architecture@birgma.test',
  'pmo@birgma.test',
];

export interface SeedResult {
  fiscalYear: number;
  mode: SeedMode;
  provenance: string;
  entityCount: number;
  lineCount: number;
}

export async function seedFrom(
  db: Db,
  fiscalYear: number,
  dataset: Dataset,
  mode: SeedMode,
): Promise<SeedResult> {
  const rng = makeRng(20260815);

  return db.transaction(async (tx) => {
    // -- Users ---------------------------------------------------------------
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

    // -- Cycle ---------------------------------------------------------------
    await tx.query(sql`
      insert into cycles (fiscal_year, phase, granularity, approval_threshold_eur)
      values (${fiscalYear}, 'collection', 'quarterly', 50000)
      on conflict (fiscal_year) do nothing
    `);

    // FR-080: every amount is addressed by a version, and every version has to
    // exist before an amount can reference it. Five years of history are
    // seeded below, so five years of working versions are declared here.
    for (let y = fiscalYear - 4; y <= fiscalYear; y += 1) {
      await tx.query(sql`
        insert into cycles (fiscal_year, phase, granularity, approval_threshold_eur)
        values (${y}, 'locked', 'quarterly', 50000)
        on conflict (fiscal_year) do nothing
      `);
      await tx.query(sql`
        insert into budget_versions (fiscal_year, key, label, kind, description, created_by)
        values (${y}, ${WORKING_VERSION}, 'Working plan', 'working',
                'The live plan. Every edit lands here.', ${adminId})
        on conflict (fiscal_year, key) do nothing
      `);
    }

    // -- FX, current year and four prior ------------------------------------
    for (const [currency, rate] of Object.entries(dataset.fx)) {
      for (let y = fiscalYear - 4; y <= fiscalYear; y += 1) {
        // Drift historical rates slightly so FR-063 volatility is non-trivial —
        // but never EUR. EUR per EUR is one in every year by definition, and a
        // drifted row made the fixture claim the reporting currency had moved
        // against itself. FR-063 rendered that as 6% of volatility, and the
        // read path only hid it because loadFxTable overrides EUR after
        // reading. A fixture should not need a guard downstream to be right.
        const drift = currency === 'EUR' ? 1 : 1 + (y - fiscalYear) * 0.015;
        const adjusted = (Number(rate) * drift).toFixed(8);
        await tx.query(sql`
          insert into fx_rates (currency, fiscal_year, rate, updated_by)
          values (${currency}, ${y}, ${adjusted}, ${adminId})
          on conflict (currency, fiscal_year) do nothing
        `);
      }
    }

    // -- Categories ----------------------------------------------------------
    const categoryIds = new Map<string, string>();
    for (const [i, category] of dataset.categories.entries()) {
      const row = await tx.one<{ id: string }>(sql`
        insert into categories (name, cost_type, position)
        values (${category.name}, ${category.costType}, ${i})
        on conflict (name) do update set position = excluded.position
        returning id
      `);
      categoryIds.set(category.name, row!.id);
    }

    // -- Cost centres. SEC-012 means the approver is a different actor from
    //    the creator, so the fixture models that rather than short-circuiting it.
    const costCentreIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const status = i < 9 ? 'approved' : i < 11 ? 'pending' : 'rejected';
      const row = await tx.one<{ id: string }>(sql`
        insert into cost_centres (code, description, status, created_by, approved_by, decided_at)
        values (
          ${`CC-${String(1000 + i)}`}, ${`Cost centre ${1000 + i}`}, ${status},
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

    // -- Reference data ------------------------------------------------------
    for (const rule of VALIDATION_RULES) {
      await tx.query(sql`
        insert into validation_rules (code, description, severity)
        values (${rule.code}, ${rule.description}, ${rule.severity})
        on conflict (code) do nothing
      `);
    }
    // -- Template version 1 (FR-005). Fields belong to a version, so the
    //    version has to exist before any field does.
    const templateVersion = await tx.one<{ id: string }>(sql`
      insert into template_versions (fiscal_year, version, state, note, published_by, published_at)
      values (${fiscalYear}, 1, 'published', 'Initial template', ${adminId}, now())
      on conflict (fiscal_year, version) do update set note = excluded.note
      returning id
    `);
    for (const [i, field] of TEMPLATE_FIELDS.entries()) {
      await tx.query(sql`
        insert into template_fields
          (fiscal_year, template_version_id, field_key, label, field_type, required, visible, position)
        values (${fiscalYear}, ${templateVersion!.id}, ${field.key}, ${field.label}, ${field.type},
                ${field.required}, ${field.visible}, ${i})
        on conflict (template_version_id, field_key) do nothing
      `);
    }

    // -- Approval stages (FR-051). Two stages so the threshold condition is
    //    exercised by the fixture rather than only by tests: everything passes
    //    Finance review, and only budgets at or above €1M also need the CFO.
    for (const stage of [
      { position: 1, name: 'Finance review', role: 'finance_manager', min: '0' },
      { position: 2, name: 'CFO sign-off', role: 'cfo', min: '1000000' },
    ]) {
      await tx.query(sql`
        insert into approval_stages (fiscal_year, position, name, required_role, min_amount_eur)
        values (${fiscalYear}, ${stage.position}, ${stage.name}, ${stage.role}, ${stage.min})
        on conflict (fiscal_year, position) do update
          set name = excluded.name, required_role = excluded.required_role,
              min_amount_eur = excluded.min_amount_eur
      `);
    }
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

    // -- Entities, owners, drivers ------------------------------------------
    const entityIds = new Map<string, string>();
    for (const [index, entity] of dataset.entities.entries()) {
      const row = await tx.one<{ id: string }>(sql`
        insert into entities
          (code, name, currency, residency, deadline, state, template_version_id)
        values (${entity.code}, ${entity.name}, ${entity.currency}, ${entity.residency},
                ${`${fiscalYear - 1}-11-30`}, 'draft', ${templateVersion!.id})
        on conflict (code) do update set name = excluded.name
        returning id
      `);
      entityIds.set(entity.code, row!.id);

      const ownerEmail = MANAGER_EMAILS[index % MANAGER_EMAILS.length]!;
      await tx.query(sql`
        insert into entity_owners (entity_id, user_id)
        values (${row!.id}, ${userIds.get(ownerEmail)!})
        on conflict do nothing
      `);

      for (const driverKey of ['headcount', 'sites', 'devices', 'stores'] as const) {
        await tx.query(sql`
          insert into drivers (entity_id, driver_key, unit, value, fiscal_year)
          values (${row!.id}, ${driverKey}, ${driverKey}, ${10 + Math.floor(rng() * 400)}, ${fiscalYear})
          on conflict (entity_id, driver_key, fiscal_year) do nothing
        `);
      }
    }

    // -- Lines, five years of plans, and recorded spend ----------------------
    let lineCount = 0;
    for (const line of dataset.lines) {
      const entityId = entityIds.get(line.entityCode);
      const categoryId = categoryIds.get(line.categoryName);
      if (!entityId || !categoryId) continue;

      const category = dataset.categories.find((c) => c.name === line.categoryName);
      const isCapex = category?.costType === 'capex';

      const row = await tx.one<{ id: string }>(sql`
        insert into line_items (
          entity_id, category_id, name, vendor, cost_centre_id, gl_account,
          cost_type, currency, justification, asset_life_years, asset_life_status,
          ledger_ref
        ) values (
          ${entityId}, ${categoryId}, ${line.name}, ${line.vendor},
          ${approvedCentres[Math.floor(rng() * approvedCentres.length)]!},
          ${`GL${4000 + (lineCount % 8)}`},
          ${isCapex ? 'capex' : 'opex'}, ${line.currency},
          ${rng() > 0.6 ? `Planned spend for ${line.categoryName.toLowerCase()}.` : null},
          ${isCapex ? 3 + Math.floor(rng() * 3) : null},
          ${isCapex ? 'approved' : null},
          -- FR-040: a stable external key so a ledger feed can address the line
          -- without knowing our UUIDs.
          ${`${line.entityCode}-${String(lineCount).padStart(4, '0')}`}
        ) returning id
      `);
      lineCount += 1;

      // The dataset carries the current year. Prior years are modelled by
      // compounding a per-line growth factor — which is what SPEC §1 describes
      // ("prior-year figures are modelled, not real"). Replace with ledger data
      // under FR-040; the summation property must keep holding.
      const growth = 0.94 + rng() * 0.16;
      for (let y = fiscalYear - 4; y <= fiscalYear; y += 1) {
        const yearFactor = growth ** (y - fiscalYear);
        for (const [i, quarter] of line.quarters.entries()) {
          const amount = Math.round(Number(quarter) * yearFactor);
          await tx.query(sql`
            insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
            values (${row!.id}, ${y}, ${i + 1}, 'working', ${String(amount)})
            on conflict (line_id, fiscal_year, period, budget_version) do nothing
          `);
        }
      }

      // Recorded spend for elapsed quarters only (FR-041).
      const ownerIndex = dataset.entities.findIndex((e) => e.code === line.entityCode);
      const ownerEmail = MANAGER_EMAILS[ownerIndex % MANAGER_EMAILS.length]!;
      for (let period = 1; period <= 2; period += 1) {
        const planned = Number(line.quarters[period - 1] ?? 0);
        await tx.query(sql`
          insert into actuals (line_id, fiscal_year, period, amount, recorded_by)
          values (${row!.id}, ${fiscalYear}, ${period},
                  ${String(Math.round(planned * (0.7 + rng() * 0.6)))},
                  ${userIds.get(ownerEmail)!})
          on conflict (line_id, fiscal_year, period) do nothing
        `);
      }
    }

    // -- Allocation pools (FR-023) ------------------------------------------
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

    // An environment should be able to say where its data came from without
    // anyone having to remember.
    await tx.query(sql`
      insert into audit_events (
        actor_user_id, actor_role, action, target_type, detail, kind
      ) values (
        ${adminId}, 'admin', 'system.seed', 'database',
        ${`Seeded FY${fiscalYear} from ${dataset.provenance}: ${dataset.entities.length} entities, ${lineCount} lines`},
        'governance'
      )
    `);

    return {
      fiscalYear,
      mode,
      provenance: dataset.provenance,
      entityCount: dataset.entities.length,
      lineCount,
    };
  });
}

/** Convenience for tests and the CLI. */
export async function seed(
  db: Db,
  fiscalYear: number,
  mode: SeedMode = 'synthetic',
  anonymisedFile = 'db/fixtures/anonymised.json',
): Promise<SeedResult> {
  const dataset = await loadDataset(mode, anonymisedFile);
  return seedFrom(db, fiscalYear, dataset, mode);
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isEntrypoint) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL must be set');
    process.exit(1);
  }

  const mode = (process.env.SEED_MODE ?? 'synthetic') as SeedMode;
  if (mode !== 'synthetic' && mode !== 'anonymised') {
    console.error(`SEED_MODE must be "synthetic" or "anonymised", got "${mode}"`);
    process.exit(1);
  }

  const db = createDb({
    DATABASE_URL: url,
    DB_POOL_MAX: 4,
    DB_STATEMENT_TIMEOUT_MS: 60_000,
    DB_SSL_MODE: (process.env.DB_SSL_MODE ?? 'disable') as 'disable' | 'require' | 'verify-full',
    DB_CA_CERT: process.env.DB_CA_CERT,
  });

  seed(
    db,
    Number(process.env.FISCAL_YEAR ?? 2026),
    mode,
    process.env.SEED_ANONYMISED_FILE ?? 'db/fixtures/anonymised.json',
  )
    .then(async (result) => {
      console.warn(
        `seeded FY${result.fiscalYear} [${result.mode}]: ` +
        `${result.entityCount} entities, ${result.lineCount} lines — ${result.provenance}`,
      );
      await db.close();
    })
    .catch(async (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      await db.close();
      process.exit(1);
    });
}

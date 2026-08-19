/**
 * Reference data and the budget grid read model.
 *
 * Every list here is scoped by the caller's read scope in the query itself, so
 * a role that may only see its own entity never has another entity's rows in
 * process memory (SEC-011, FR-071's principle applied to business data).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Money, schemas, WORKING_VERSION } from '@spendifre/shared';
import type { AppConfig, ServedScope } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requireReadEntity } from '../http/guard.ts';
import { notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import {
  computeLineTotals,
  effectivePeriodAmount,
  elapsedPeriods,
  isOverPace,
  loadFxTable,
  loadLines,
  rollUp,
  toEur,
} from '../services/budget.ts';
import { readScope } from '@spendifre/shared';
import { servedEntityClause } from '../services/residency.ts';

export interface CycleRow {
  fiscal_year: number;
  phase: string;
  granularity: string;
  lock_date: string | null;
  lock_enabled: boolean;
  headcount_planning: boolean;
  approval_threshold_eur: string;
}

export async function loadCycle(db: Db, fiscalYear: number): Promise<CycleRow> {
  const cycle = await db.one<CycleRow>(sql`
    select fiscal_year, phase, granularity, lock_date::text as lock_date,
           lock_enabled, headcount_planning,
           approval_threshold_eur::text as approval_threshold_eur
    from cycles where fiscal_year = ${fiscalYear}
  `);
  if (!cycle) throw notFound('no cycle configured for this fiscal year');
  return cycle;
}

export const periodsIn = (granularity: string): number =>
  granularity === 'monthly' ? 12 : 4;

/**
 * SPEC §9.4, single-entity form. A deployment serves only entities inside its
 * scope; anything else resolves to "not found" rather than "forbidden", so the
 * response does not confirm that the entity exists elsewhere (SEC-011).
 */
export async function assertEntityServed(
  db: Db,
  entityId: string,
  scope: ServedScope,
): Promise<void> {
  const row = await db.one(sql`
    select 1 from entities e
    where e.id = ${entityId} and ${servedEntityClause(scope)}
  `);
  if (!row) throw notFound('entity is not served by this deployment');
}

/**
 * Entity IDs the caller may read (SEC-011), narrowed to what this deployment
 * serves (SPEC §9.4).
 *
 * Both filters live here, in the one function every read path calls, rather
 * than being repeated per endpoint. An earlier arrangement applied residency
 * only in the entity list, and the consolidation report happily summed Swiss
 * and mainland-China rows into a EUR total served from the EU deployment —
 * which is exactly the cross-border processing CMP-140 exists to prevent.
 * Scope rules belong in one place precisely because a second place will be
 * forgotten.
 *
 * The residency half of that rule now lives one level further down again, in
 * `servedEntityClause`, because it grew a second dimension: a bucket and a
 * country. Two conditions written out at each call site is the same mistake
 * with more surface.
 */
export async function visibleEntityIds(
  db: Db,
  request: Parameters<typeof principalOf>[0],
  scope: ServedScope,
): Promise<string[]> {
  const principal = principalOf(request);

  if (readScope(principal.role) === 'all') {
    const rows = await db.query<{ id: string }>(sql`
      select e.id from entities e where ${servedEntityClause(scope)} order by e.code
    `);
    return rows.map((r) => r.id);
  }

  if (principal.ownedEntityIds.length === 0) return [];

  const rows = await db.query<{ id: string }>(sql`
    select e.id from entities e
    where e.id = any(${[...principal.ownedEntityIds]}::uuid[])
      and ${servedEntityClause(scope)}
    order by e.code
  `);
  return rows.map((r) => r.id);
}

export async function registerMetaRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  app.get('/api/cycle', { config: authenticatedRoute }, async () =>
    loadCycle(db, config.FISCAL_YEAR),
  );

  app.get('/api/categories', { config: authenticatedRoute }, async () =>
    db.query(sql`
      select id, name, cost_type as "costType", position
      from categories order by position
    `),
  );

  app.get('/api/entities', { config: authenticatedRoute }, async (request) => {
    const ids = await visibleEntityIds(db, request, config.served);
    if (ids.length === 0) return [];
    return db.query(sql`
      select e.id, e.code, e.name, e.currency, e.state, e.deadline::text as deadline,
             e.residency, e.country, co.name as "countryName",
             coalesce(u.display_name, '') as "ownerName"
      from entities e
      join countries co on co.code = e.country
      left join entity_owners eo on eo.entity_id = e.id
      left join users u on u.id = eo.user_id
      -- visibleEntityIds has already applied both the caller's read scope
      -- and this deployment's region.
      where e.id = any(${ids}::uuid[])
      order by e.code
    `);
  });

  /**
   * The countries an entity may be filed under here — the served ones, not all
   * eleven. Listing a country this deployment refuses to create an entity in
   * would put a choice on the form whose only outcome is an error.
   */
  app.get('/api/countries', { config: authenticatedRoute }, async () => {
    const { regions, countries } = config.served;
    const limit = countries === null ? sql`true` : sql`code = any(${[...countries]}::text[])`;
    return db.query(sql`
      select code, name, residency from countries
      where residency = any(${[...regions]}::text[]) and ${limit}
      order by name
    `);
  });

  app.get('/api/cost-centres', { config: authenticatedRoute }, async () =>
    // FR-013: managers may only book to approved centres, but every centre is
    // listed with its status so a stale reference can be rendered as an
    // exception rather than silently cleared (INV-2).
    db.query(sql`
      select id, code, description, status
      from cost_centres order by code
    `),
  );

  app.get('/api/fx-rates', { config: authenticatedRoute }, async (request) => {
    const query = request.query as { fiscalYear?: string };
    const year = query.fiscalYear ? Number(query.fiscalYear) : config.FISCAL_YEAR;
    const validYear = parse(schemas.fiscalYear, year);
    return db.query(sql`
      select currency, fiscal_year as "fiscalYear", rate::text as rate
      from fx_rates where fiscal_year = ${validYear} order by currency
    `);
  });

  app.get('/api/drivers', { config: authenticatedRoute }, async (request) => {
    const ids = await visibleEntityIds(db, request, config.served);
    if (ids.length === 0) return [];
    // FR-020: `terms` is the definition and `value` is the resolved figure.
    // Both are returned so the view can show a derived driver as read-only
    // beside its definition, rather than as a number someone might type over
    // and lose.
    return db.query(sql`
      select d.id, d.entity_id as "entityId", d.driver_key as "driverKey",
             d.unit, d.value,
             (
               select coalesce(json_agg(
                 json_build_object('derivedFrom', t.source_key, 'factor', t.factor::text)
                 order by t.source_key
               ), '[]'::json)
               from driver_terms t
               where t.entity_id = d.entity_id
                 and t.fiscal_year = d.fiscal_year
                 and t.driver_key = d.driver_key
             ) as terms
      from drivers d
      where d.entity_id = any(${ids}::uuid[]) and d.fiscal_year = ${config.FISCAL_YEAR}
      order by d.driver_key
    `);
  });

  /**
   * The budget grid (FR-010..FR-016).
   *
   * Returns lines with local and EUR figures side by side. FR-014's "a row
   * never mixes currencies" is a rendering rule, so the API hands the client
   * both units plus the line's currency code and lets the view pick one — it
   * cannot pick a different one per column.
   */
  app.get('/api/budget/:entityId', { config: authenticatedRoute }, async (request) => {
    const { entityId } = parse(z.object({ entityId: schemas.uuid }), request.params);
    requireReadEntity(request, entityId);
    await assertEntityServed(db, entityId, config.served);

    const cycle = await loadCycle(db, config.FISCAL_YEAR);
    const periods = periodsIn(cycle.granularity);
    const fx = await loadFxTable(db, config.FISCAL_YEAR);
    const lines = await loadLines(db, [entityId], config.FISCAL_YEAR, WORKING_VERSION);
    const totals = computeLineTotals(lines, fx, cycle.headcount_planning, periods);
    const totalsById = new Map(totals.map((t) => [t.lineId, t]));

    const threshold = Money.parse(cycle.approval_threshold_eur);
    const elapsed = elapsedPeriods(config.FISCAL_YEAR, periods);

    return {
      cycle,
      periods,
      lines: lines.map((line) => {
        const total = totalsById.get(line.id)!;
        const periodValues = Array.from({ length: periods }, (_, i) =>
          effectivePeriodAmount(line, i + 1, cycle.headcount_planning, periods).toString(),
        );
        return {
          id: line.id,
          categoryId: line.categoryId,
          categoryName: line.categoryName,
          name: line.name,
          vendor: line.vendor,
          costCentreId: line.costCentreId,
          costCentreCode: line.costCentreCode,
          // INV-2: a reference to a non-approved centre is surfaced, not cleared.
          costCentreException:
            line.costCentreId !== null && line.costCentreStatus !== 'approved',
          costCentreStatus: line.costCentreStatus,
          glAccount: line.glAccount,
          costType: line.costType,
          currency: line.currency,
          justification: line.justification,
          driverKey: line.driverKey,
          driverRatePerUnit: line.driverRatePerUnit,
          driverValue: line.driverValue,
          // FR-022: headcount-linked lines go dormant when planning is off.
          dormant:
            line.driverKey === 'headcount' && !cycle.headcount_planning,
          // FR-021: driver-linked amounts are read-only in the grid.
          computed: line.driverKey !== null && line.driverRatePerUnit !== null,
          assetLifeYears: line.assetLifeYears,
          assetLifeStatus: line.assetLifeStatus,
          version: line.version,
          periodsLocal: periodValues,
          totalLocal: total.local.toString(),
          totalEur: total.eur.toString(),
          actualLocal: total.actualLocal.toString(),
          actualEur: total.actualEur.toString(),
          // FR-003: above the configured threshold, flagged for approval.
          aboveThreshold: total.eur.compare(threshold) > 0,
          // FR-042: consuming faster than time elapsed.
          overPace: isOverPace(total.eur, total.actualEur, elapsed, periods),
          // FR-016: completeness over required fields.
          complete:
            line.name.trim().length > 0 &&
            line.costCentreId !== null &&
            line.costCentreStatus === 'approved' &&
            !total.local.isZero(),
        };
      }),
      categoryTotals: [...rollUp(lines, totals, (l) => l.categoryId)].map(
        ([categoryId, t]) => ({
          categoryId,
          plan: t.plan.toString(),
          actual: t.actual.toString(),
        }),
      ),
      entityTotal: {
        plan: Money.sum(totals.map((t) => t.eur)).toString(),
        actual: Money.sum(totals.map((t) => t.actualEur)).toString(),
      },
      elapsedPeriods: elapsed,
    };
  });

  /** FR-012: the side panel exposes every field, including ones hidden in the grid. */
  app.get('/api/lines/:lineId', { config: authenticatedRoute }, async (request) => {
    const { lineId } = parse(z.object({ lineId: schemas.uuid }), request.params);

    // Resolve the owning entity first, then authorise, then load. Doing it in
    // this order means an out-of-scope identifier never reaches a data query.
    const line = await db.one<{ entity_id: string }>(sql`
      select entity_id from line_items where id = ${lineId} and deleted_at is null
    `);
    if (!line) throw notFound('line does not exist');
    requireReadEntity(request, line.entity_id);
    await assertEntityServed(db, line.entity_id, config.served);

    const cycle = await loadCycle(db, config.FISCAL_YEAR);
    const periods = periodsIn(cycle.granularity);
    const fx = await loadFxTable(db, config.FISCAL_YEAR);
    const detail = (await loadLines(db, [line.entity_id], config.FISCAL_YEAR))
      .find((l) => l.id === lineId);
    if (!detail) throw notFound('line does not exist');

    const comments = await db.query(sql`
      select c.id, c.body, c.created_at as "createdAt",
             coalesce(u.display_name, 'Removed user') as author
      from line_comments c
      join users u on u.id = c.author_id
      where c.line_id = ${lineId}
      order by c.created_at
    `);

    const periodValues = Array.from({ length: periods }, (_, i) =>
      effectivePeriodAmount(detail, i + 1, cycle.headcount_planning, periods),
    );
    const totalLocal = Money.sum(periodValues);

    return {
      line: {
        id: detail.id,
        entityId: detail.entityId,
        categoryId: detail.categoryId,
        name: detail.name,
        vendor: detail.vendor,
        costCentreId: detail.costCentreId,
        costCentreCode: detail.costCentreCode,
        costCentreStatus: detail.costCentreStatus,
        glAccount: detail.glAccount,
        costType: detail.costType,
        currency: detail.currency,
        justification: detail.justification,
        driverKey: detail.driverKey,
        driverRatePerUnit: detail.driverRatePerUnit,
        driverValue: detail.driverValue,
        assetLifeYears: detail.assetLifeYears,
        assetLifeStatus: detail.assetLifeStatus,
        version: detail.version,
        periodsLocal: periodValues.map((m) => m.toString()),
        totalLocal: totalLocal.toString(),
        totalEur: toEur(totalLocal, detail.currency, fx).toString(),
        actuals: detail.actuals,
      },
      comments,
    };
  });
}

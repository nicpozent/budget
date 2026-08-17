/**
 * Depreciation flow-through (FR-033).
 *
 * A capex line approved this year generates a straight-line schedule (FR-030).
 * FR-033 asks for the next year's charge to appear in *that year's opex plan* —
 * not as a report someone reads and retypes, but as plan figures.
 *
 * The implementation makes the charge a derived line, the same shape FR-021
 * already uses for driver-linked amounts: the line exists in the grid, it is
 * read-only, and it points at what produced it. Regeneration is idempotent —
 * one derived line per source line — so running it after every capex change is
 * safe and is the intended usage.
 *
 * Two decisions worth stating:
 *
 *   Only *approved* asset lives flow through. FR-031 gives the Finance Manager
 *   the decision, so a pending life is provisional and planning against it would
 *   be planning against a number nobody has agreed.
 *
 *   The charge is written in the source line's own currency, not EUR. Every
 *   other amount in the grid is stored local and converted at read time; a
 *   derived line that broke that rule would restate differently from its
 *   neighbours when the FY rate changed.
 */

import { Money } from '@spendifre/shared';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { depreciationSchedule } from './budget.ts';

export interface FlowThroughResult {
  /** Derived lines created or refreshed. */
  linesWritten: number;
  /** Derived lines removed because their source no longer qualifies. */
  linesRemoved: number;
  /** The fiscal year the charges were written into. */
  targetYear: number;
  totalCharge: string;
  entitiesAffected: number;
}

interface CapexLine {
  id: string;
  entity_id: string;
  category_id: string;
  name: string;
  currency: string;
  asset_life_years: number;
  capitalised: string;
}

/**
 * Regenerate next year's derived opex lines from this year's approved capex.
 * Runs in one transaction: a half-applied flow-through would leave a plan that
 * sums to something nobody chose.
 */
export async function regenerateFlowThrough(
  db: Db,
  fiscalYear: number,
): Promise<FlowThroughResult> {
  const targetYear = fiscalYear + 1;

  return db.transaction(async (tx) => {
    // FR-080: the charge lands in *next* year, and every amount is addressed by
    // a declared version (migration 008). Next year's cycle may not exist yet —
    // this feature runs during this year's collection — so the cycle and its
    // working version are created here for the same reason the category below
    // is: the flow-through should work on a fresh deployment without an
    // administrator having prepared the following year first.
    //
    // The cycle is created in `collection`, which is what a year nobody has
    // opened yet is. It carries no lock and no exceptions.
    await tx.query(sql`
      insert into cycles (fiscal_year) values (${targetYear})
      on conflict (fiscal_year) do nothing
    `);
    await tx.query(sql`
      insert into budget_versions (fiscal_year, key, label, kind, description, created_by)
      select ${targetYear}, 'working', 'Working plan', 'working',
             'Opened by the FR-033 depreciation flow-through.',
             (select id from users where role = 'admin' order by created_at limit 1)
      on conflict (fiscal_year, key) do nothing
    `);

    // The opex category derived charges land in. Created if absent so the
    // feature works on a fresh cycle without an administrator preparing one.
    const category = await tx.one<{ id: string }>(sql`
      insert into categories (name, cost_type, position)
      values ('Depreciation', 'opex',
              (select coalesce(max(position), 0) + 1 from categories))
      on conflict (name) do update set cost_type = 'opex'
      returning id
    `);

    const capex = await tx.query<CapexLine>(sql`
      select li.id, li.entity_id, li.category_id, li.name, li.currency,
             li.asset_life_years,
             coalesce((
               select sum(pa.amount) from period_amounts pa
               where pa.line_id = li.id and pa.fiscal_year = ${fiscalYear}
                 and pa.budget_version = 'working'
             ), 0)::text as capitalised
      from line_items li
      where li.cost_type = 'capex'
        and li.deleted_at is null
        and li.derived_from_line_id is null
        -- FR-031: a provisional asset life is not a plan.
        and li.asset_life_status = 'approved'
        and li.asset_life_years is not null
      order by li.id
    `);

    const qualifying = new Set<string>();
    const entities = new Set<string>();
    let total = Money.ZERO;
    let written = 0;

    for (const line of capex) {
      const capitalised = Money.parse(line.capitalised);
      const schedule = depreciationSchedule(capitalised, line.asset_life_years, fiscalYear);
      const nextCharge = schedule.find((s) => s.year === targetYear)?.charge;
      // A one-year asset life is fully depreciated in the capex year, so there
      // is nothing to flow through. Neither is a zero-value line.
      if (!nextCharge || nextCharge.isZero()) continue;

      qualifying.add(line.id);
      entities.add(line.entity_id);
      total = total.add(nextCharge);

      const derived = await tx.one<{ id: string }>(sql`
        insert into line_items
          (entity_id, category_id, name, cost_type, currency,
           derived_from_line_id, derived_kind)
        values (${line.entity_id}, ${category!.id},
                ${`Depreciation — ${line.name}`}, 'opex', ${line.currency},
                ${line.id}, 'depreciation')
        on conflict (derived_from_line_id, derived_kind)
          where derived_from_line_id is not null and deleted_at is null
        do update set name = excluded.name, currency = excluded.currency,
                      category_id = excluded.category_id, version = line_items.version + 1
        returning id
      `);

      // The charge is an annual figure; it is spread evenly across the target
      // year's periods, with the remainder on the last, so the periods sum back
      // to the charge exactly (INV-4).
      const periods = 4;
      const perPeriod = nextCharge.divideByRate(String(periods));
      let remaining = nextCharge;
      for (let p = 1; p <= periods; p += 1) {
        const amount = p === periods ? remaining : perPeriod;
        remaining = remaining.subtract(amount);
        await tx.query(sql`
          insert into period_amounts (line_id, fiscal_year, period, budget_version, amount)
          values (${derived!.id}, ${targetYear}, ${p}, 'working', ${amount.toString()})
          on conflict (line_id, fiscal_year, period, budget_version)
          do update set amount = excluded.amount, updated_at = now()
        `);
      }
      written += 1;
    }

    // Derived lines whose source no longer qualifies — the capex line was
    // deleted, its asset life was rejected, or its amount went to zero — are
    // removed. Leaving them would mean a plan carrying depreciation for an asset
    // nobody is buying.
    const stale =
      qualifying.size > 0
        ? await tx.query<{ id: string }>(sql`
            update line_items set deleted_at = now()
            where derived_kind = 'depreciation' and deleted_at is null
              and derived_from_line_id <> all(${[...qualifying]}::uuid[])
            returning id
          `)
        : await tx.query<{ id: string }>(sql`
            update line_items set deleted_at = now()
            where derived_kind = 'depreciation' and deleted_at is null
            returning id
          `);

    return {
      linesWritten: written,
      linesRemoved: stale.length,
      targetYear,
      totalCharge: total.toString(),
      entitiesAffected: entities.size,
    };
  });
}

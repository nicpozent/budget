/**
 * Driver trees (FR-020).
 *
 * A driver is either typed in or *defined* as a sum of terms over other drivers
 * for the same entity and year — `devices = 1.5 per head + 2 per site` — so that
 * changing headcount moves everything downstream of it in one edit instead of
 * several that can disagree.
 *
 * A term is a row, not an expression. Nothing is parsed and nothing
 * user-supplied is interpreted; addition and multiplication by a constant are
 * structure rather than syntax, which is why this does not reopen ADR 0007's
 * argument against a formula engine.
 *
 * Two decisions worth stating, because both were choices and not defaults:
 *
 *   The resolved figure is stored, not computed at read time. `drivers.value`
 *   still holds a plain integer, so the grid, the SQL fold and the allocation
 *   report are untouched and a tree cannot make a report slower or make two
 *   readers of the same driver disagree. Materialising it is the same pattern
 *   FR-033 uses for depreciation flow-through.
 *
 *   Acyclicity is enforced here rather than in the schema. A CHECK can refuse
 *   `devices` derived from `devices`, and migration 008 does; it cannot refuse
 *   headcount → sites → headcount. So the resolver detects cycles, every write
 *   runs it before committing, and the runtime self-test re-derives every
 *   stored value against its definition — a tree that stopped agreeing with
 *   itself is a failing check rather than a wrong budget.
 *
 * Rounding: a derived count is a count. `devices = 250 headcount × 1.5` is 375
 * devices, and `× 1.4` is 350. Halves round away from zero, matching `Money`,
 * so the rule is the same one used everywhere else rather than a second one to
 * remember.
 */

import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { validationFailed } from '../http/errors.ts';

/** One term of a definition: this much of that driver. */
export interface DriverTerm {
  sourceKey: string;
  factor: string;
}

export interface DriverNode {
  driverKey: string;
  unit: string;
  /** The typed-in figure for a root driver; ignored when `terms` is non-empty. */
  value: number;
  /** Empty for a driver that is typed in rather than derived. */
  terms: readonly DriverTerm[];
}

export class DriverCycleError extends Error {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`driver definition is circular: ${cycle.join(' → ')}`);
    this.name = 'DriverCycleError';
    this.cycle = cycle;
  }
}

/** Half away from zero, on a non-negative count. Matches `Money`'s rule. */
function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** A node is derived when it has terms, and typed in when it does not. */
export const isDerived = (node: DriverNode): boolean => node.terms.length > 0;

/**
 * Resolve every driver's value from the tree, returning the resolved figure per
 * key.
 *
 * Pure and total: it either returns a value for every node or throws. It never
 * returns a partially resolved map, because a caller that wrote one back would
 * leave half a tree materialised and half stale.
 */
export function resolveDriverTree(nodes: readonly DriverNode[]): Map<string, number> {
  const byKey = new Map(nodes.map((n) => [n.driverKey, n]));
  const resolved = new Map<string, number>();
  // 'resolving' rather than a plain visited set: a node reached twice by
  // different paths is fine, a node reached while it is still being resolved is
  // the cycle.
  const resolving = new Set<string>();
  const path: string[] = [];

  const resolve = (key: string): number => {
    const cached = resolved.get(key);
    if (cached !== undefined) return cached;

    if (resolving.has(key)) {
      throw new DriverCycleError([...path.slice(path.indexOf(key)), key]);
    }

    const node = byKey.get(key);
    if (!node) {
      // A definition pointing at a driver the entity has not set. Refused
      // rather than treated as zero: a silent zero would make every line
      // downstream of it plan nothing, which looks like a decision.
      throw validationFailed({
        derivedFrom: `driver "${key}" is referenced but not set for this entity`,
      });
    }

    resolving.add(key);
    path.push(key);
    // Rounded once, over the whole sum, rather than per term. Rounding each
    // term would accumulate up to half a unit of error for every term, so a
    // three-term definition could land a unit away from the figure a reader
    // computes by hand — and the figure a reader computes by hand is the one
    // this has to match.
    const value = isDerived(node)
      ? roundHalfUp(
          node.terms.reduce((sum, t) => sum + resolve(t.sourceKey) * Number(t.factor), 0),
        )
      : node.value;
    path.pop();
    resolving.delete(key);

    resolved.set(key, value);
    return value;
  };

  for (const node of nodes) resolve(node.driverKey);
  return resolved;
}

/** Every driver row for one entity and year, with its terms, in key order. */
export async function loadDriverTree(
  db: Db,
  entityId: string,
  fiscalYear: number,
): Promise<DriverNode[]> {
  const rows = await db.query<{
    driver_key: string;
    unit: string;
    value: number;
    terms: { sourceKey: string; factor: string }[] | null;
  }>(sql`
    select d.driver_key, d.unit, d.value,
           (
             select coalesce(json_agg(
               json_build_object('sourceKey', t.source_key, 'factor', t.factor::text)
               order by t.source_key
             ), '[]'::json)
             from driver_terms t
             where t.entity_id = d.entity_id
               and t.fiscal_year = d.fiscal_year
               and t.driver_key = d.driver_key
           ) as terms
    from drivers d
    where d.entity_id = ${entityId} and d.fiscal_year = ${fiscalYear}
    order by d.driver_key
  `);
  return rows.map((r) => ({
    driverKey: r.driver_key,
    unit: r.unit,
    value: r.value,
    terms: r.terms ?? [],
  }));
}

/**
 * Re-derive and store every derived driver for one entity and year.
 *
 * Called after any driver write. Returns the keys whose stored value changed,
 * so the audit entry can say what the edit actually moved rather than only what
 * was typed — FR-021's "the change is recorded with its blast radius" applied
 * to a tree instead of a single driver.
 */
export async function recomputeDriverTree(
  tx: Db,
  entityId: string,
  fiscalYear: number,
): Promise<{ key: string; from: number; to: number }[]> {
  const nodes = await loadDriverTree(tx, entityId, fiscalYear);
  const resolved = resolveDriverTree(nodes);

  const changed: { key: string; from: number; to: number }[] = [];
  for (const node of nodes) {
    if (!isDerived(node)) continue;
    const to = resolved.get(node.driverKey)!;
    if (to === node.value) continue;
    changed.push({ key: node.driverKey, from: node.value, to });
    await tx.query(sql`
      update drivers set value = ${to}
      where entity_id = ${entityId} and fiscal_year = ${fiscalYear}
        and driver_key = ${node.driverKey}
    `);
  }
  return changed;
}

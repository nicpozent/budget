/**
 * Driver trees (FR-020).
 *
 * A driver could always be typed in. It can now also be *defined* as a multiple
 * of another driver for the same entity and year — devices per head, sites per
 * store — so that changing headcount moves everything downstream of it in one
 * edit instead of several that can disagree.
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

export interface DriverNode {
  driverKey: string;
  unit: string;
  /** The typed-in figure for a root driver; ignored for a derived one. */
  value: number;
  derivedFrom: string | null;
  /** Multiplier applied to the parent's resolved value. */
  factor: string | null;
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
    const value = node.derivedFrom === null || node.factor === null
      ? node.value
      : roundHalfUp(resolve(node.derivedFrom) * Number(node.factor));
    path.pop();
    resolving.delete(key);

    resolved.set(key, value);
    return value;
  };

  for (const node of nodes) resolve(node.driverKey);
  return resolved;
}

/** Every driver row for one entity and year, in key order. */
export async function loadDriverTree(
  db: Db,
  entityId: string,
  fiscalYear: number,
): Promise<DriverNode[]> {
  const rows = await db.query<{
    driver_key: string;
    unit: string;
    value: number;
    derived_from: string | null;
    factor: string | null;
  }>(sql`
    select driver_key, unit, value, derived_from, factor::text as factor
    from drivers
    where entity_id = ${entityId} and fiscal_year = ${fiscalYear}
    order by driver_key
  `);
  return rows.map((r) => ({
    driverKey: r.driver_key,
    unit: r.unit,
    value: r.value,
    derivedFrom: r.derived_from,
    factor: r.factor,
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
    if (node.derivedFrom === null) continue;
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

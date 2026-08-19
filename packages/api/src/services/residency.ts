/**
 * Which entities this deployment is allowed to serve (SPEC §9.4).
 *
 * There is one predicate and this is it. Every read and every write resolves
 * an entity through `servedEntityClause`, so widening or narrowing what a
 * deployment serves is a change to one function rather than a sweep across
 * every query that happens to mention `entities`.
 *
 * That is not a style preference. The clause used to be written out at each
 * call site as `residency = any(...)`, and the copy in the consolidation
 * report was missing — the EU deployment summed Swiss and mainland-China rows
 * into a EUR total for months. Two dimensions instead of one makes a second
 * omission likelier, not less likely, so the second dimension arrived with the
 * duplication removed.
 *
 * The two dimensions answer different questions:
 *
 *   regions    which residency buckets this deployment holds. An allow-list,
 *              defaulting to the home region alone.
 *   countries  which of the countries inside those buckets it serves. `null`
 *              means all of them, which is the setting's absent state and the
 *              behaviour that existed before it did.
 *
 * `apac` is why the second one exists: it is one bucket covering Singapore,
 * India and Vietnam, so before `country` the answer to "serve Singapore but
 * not Vietnam" was that the model could not say it.
 */

import type { ServedScope } from '../config.ts';
import type { SqlFragment } from '../db/pool.ts';
import { join, sql } from '../db/pool.ts';

export type { ServedScope };

/**
 * A predicate over an `entities` row **aliased `e`**.
 *
 * The alias is fixed rather than a parameter because a parameter would be an
 * identifier assembled into SQL text, which SEC-020 does not allow without an
 * allow-list, and an allow-list of one is a longer way of writing this. A call
 * site that aliases the table something else fails as a SQL error on first
 * execution, which the tests reach.
 */
export function servedEntityClause(scope: ServedScope): SqlFragment {
  const parts = [sql`e.residency = any(${[...scope.regions]}::text[])`];
  if (scope.countries !== null) {
    parts.push(sql`e.country = any(${[...scope.countries]}::text[])`);
  }
  return join(parts, ' and ');
}

/**
 * The same rule stated for a caller that has already loaded the row — the
 * entity form's country picker, and the self-test's inventory of what is out
 * of scope.
 */
export function isServed(
  scope: ServedScope,
  entity: { residency: string; country: string },
): boolean {
  if (!scope.regions.some((r) => r === entity.residency)) return false;
  return scope.countries === null || scope.countries.includes(entity.country);
}

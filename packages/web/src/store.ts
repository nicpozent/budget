/**
 * Shared client state.
 *
 * The problem this solves is small and specific: several views each called
 * `GET /api/entities` on mount, so switching between them refetched a list that
 * had not changed, and two views could hold different copies of it.
 *
 * The solution is deliberately not a state library. What Redux or Zustand add
 * over this is middleware, devtools and time-travel — none of which apply to one
 * cached list and a selected id, and all of which put a dependency inside the
 * trust boundary that ADR-0004 sets a high bar for. `useSyncExternalStore` is
 * the React-supported way to subscribe to an external store and is already in
 * the runtime.
 *
 * The store holds *server cache*, not truth. Nothing here is authoritative:
 * every write goes to the API and the affected entry is invalidated, because a
 * client that reasons from its own cache is a client that eventually shows a
 * figure the server disagrees with.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { api } from './api.ts';
import type { Entity } from './types.ts';

interface StoreState {
  entities: Entity[] | null;
  entitiesLoading: boolean;
  /** The entity the budget workspace is showing. Empty means "not chosen yet". */
  chosenEntityId: string;
}

let state: StoreState = { entities: null, entitiesLoading: false, chosenEntityId: '' };

const listeners = new Set<() => void>();

function set(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = (): StoreState => state;

/**
 * Entities, fetched once and shared.
 *
 * The in-flight guard matters: three views mounting in the same tick would
 * otherwise issue three identical requests, and the last response to land would
 * win. It is a boolean rather than a promise cache because there is exactly one
 * request in question.
 */
export function useEntities(): { entities: Entity[]; loading: boolean } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  if (current.entities === null && !current.entitiesLoading) {
    set({ entitiesLoading: true });
    api
      .get<Entity[]>('/api/entities')
      .then((entities) => set({ entities, entitiesLoading: false }))
      // An empty list is the honest failure mode here: every view renders
      // "no entity in scope", which is what the caller sees when they have none.
      .catch(() => set({ entities: [], entitiesLoading: false }));
  }

  return { entities: current.entities ?? [], loading: current.entitiesLoading };
}

/** The budget workspace's entity selection, shared so it survives navigation. */
export function useChosenEntity(): [string, (id: string) => void] {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const choose = useCallback((id: string) => set({ chosenEntityId: id }), []);
  return [current.chosenEntityId, choose];
}

/**
 * Drop the cached entity list so the next read refetches.
 *
 * Called after anything that changes an entity's state — a submission, a stage
 * decision — because the list carries `state`, and a stale chip claiming
 * "Draft" next to a budget that was just approved is worse than a brief spinner.
 */
export function invalidateEntities(): void {
  set({ entities: null, entitiesLoading: false });
}

/** Test seam: resets module state between cases. */
export function resetStore(): void {
  state = { entities: null, entitiesLoading: false, chosenEntityId: '' };
  listeners.clear();
}

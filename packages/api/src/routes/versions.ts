/**
 * Budget versions and scenarios (FR-080).
 *
 * Reading is open to any authenticated caller and writing needs
 * `version.manage`, which is an asymmetry worth stating. Which scenarios exist
 * is not sensitive; the figures inside one are, and those come back through the
 * same scope resolver and the same fold as every other report, so a manager
 * comparing two scenarios sees their own entities in both and nobody else's in
 * either (SEC-011).
 *
 * The write side is step-up (ZT-007). Deleting a version takes its amounts with
 * it by cascade and locking one turns a workspace into a record; neither is
 * something a stale session should be able to do.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schemas } from '@spendifre/shared';
import type { Money } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { authenticatedRoute, principalOf, requires } from '../http/guard.ts';
import { conflict, notFound } from '../http/errors.ts';
import { parse } from '../http/validate.ts';
import { writeAudit } from '../services/audit.ts';
import { elapsedPeriods } from '../services/budget.ts';
import {
  compareVersions,
  createVersion,
  getVersion,
  listVersions,
  rebaseForecast,
} from '../services/versions.ts';
import { loadCycle, periodsIn, visibleEntityIds } from './meta.ts';

export async function registerVersionRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const year = config.FISCAL_YEAR;

  /** FR-080: which versions exist for the cycle. */
  app.get('/api/versions', { config: authenticatedRoute }, async () => ({
    fiscalYear: year,
    versions: await listVersions(db, year),
  }));

  app.post(
    '/api/versions',
    { config: requires('version.manage') },
    async (request, reply) => {
      const body = parse(schemas.createVersionSchema, request.body);
      const principal = principalOf(request);

      const result = await db.transaction(async (tx) => {
        const created = await createVersion(tx, {
          fiscalYear: year,
          key: body.key,
          label: body.label,
          kind: body.kind,
          description: body.description ?? null,
          copyFrom: body.copyFrom ?? null,
          createdBy: principal.userId,
        });

        await writeAudit(tx, {
          actor: principal,
          action: 'version.create',
          targetType: 'budget_version',
          targetId: null,
          detail: body.copyFrom
            ? `Created ${body.kind} "${body.label}" (${body.key}) as a copy of ` +
              `${body.copyFrom}: ${created.copiedRows} amounts`
            : `Created empty ${body.kind} "${body.label}" (${body.key})`,
          kind: 'governance',
          request,
        });

        return created;
      });

      return reply.code(201).send({
        version: result.version,
        copiedRows: result.copiedRows,
      });
    },
  );

  /**
   * FR-080 rolling forecast: recorded spend for the periods that have closed,
   * the working plan for the ones that have not.
   *
   * An explicit action rather than a view, so a forecast someone has adjusted
   * by hand does not silently revert when a period closes.
   */
  app.post(
    '/api/versions/:key/rebase',
    { config: requires('version.manage') },
    async (request) => {
      const { key } = parse(z.object({ key: schemas.versionKey }), request.params);
      const principal = principalOf(request);

      const version = await getVersion(db, year, key);
      if (!version) throw notFound('no such budget version');
      if (version.kind !== 'forecast') {
        throw conflict('only a forecast version can be rebased from actuals');
      }
      if (version.locked) throw conflict(`version "${version.label}" is locked`);

      const cycle = await loadCycle(db, year);
      const elapsed = elapsedPeriods(year, periodsIn(cycle.granularity));

      const result = await db.transaction(async (tx) => {
        const rebased = await rebaseForecast(tx, year, key, elapsed);
        await writeAudit(tx, {
          actor: principal,
          action: 'version.rebase',
          targetType: 'budget_version',
          targetId: null,
          detail:
            `Rebased forecast "${version.label}" (${key}): actuals for periods 1-${elapsed}, ` +
            `working plan thereafter, ${rebased.rows} amounts`,
          kind: 'governance',
          request,
        });
        return rebased;
      });

      return { ...result, totalPeriods: periodsIn(cycle.granularity) };
    },
  );

  app.post(
    '/api/versions/:key/lock',
    { config: requires('version.manage') },
    async (request) => {
      const { key } = parse(z.object({ key: schemas.versionKey }), request.params);
      const { locked } = parse(z.object({ locked: z.boolean() }), request.body);
      const principal = principalOf(request);

      const version = await getVersion(db, year, key);
      if (!version) throw notFound('no such budget version');
      if (version.kind === 'working') {
        // Locking the live plan is what `cycles.lock_enabled` is for, and it
        // has a whole exception mechanism behind it (FR-050). Two ways to
        // freeze the same thing, with different escape hatches, is a way to
        // wedge a cycle.
        throw conflict('lock the working plan through the cycle, not the version');
      }

      await db.transaction(async (tx) => {
        await tx.query(sql`
          update budget_versions
          set locked = ${locked}, locked_at = ${locked ? new Date() : null}
          where fiscal_year = ${year} and key = ${key}
        `);
        await writeAudit(tx, {
          actor: principal,
          action: locked ? 'version.lock' : 'version.unlock',
          targetType: 'budget_version',
          targetId: null,
          detail: `${locked ? 'Locked' : 'Unlocked'} ${version.kind} "${version.label}" (${key})`,
          kind: 'governance',
          request,
        });
      });

      return { ok: true, locked };
    },
  );

  app.delete(
    '/api/versions/:key',
    { config: requires('version.manage') },
    async (request) => {
      const { key } = parse(z.object({ key: schemas.versionKey }), request.params);
      const principal = principalOf(request);

      const version = await getVersion(db, year, key);
      if (!version) throw notFound('no such budget version');
      // Both of these are also refused by the trigger in migration 008. The
      // handler checks so the caller gets a sentence rather than a 500 from a
      // raised exception.
      if (version.kind === 'working') throw conflict('the working version cannot be deleted');
      if (version.locked) throw conflict(`version "${version.label}" is locked`);

      await db.transaction(async (tx) => {
        await tx.query(sql`
          delete from budget_versions where fiscal_year = ${year} and key = ${key}
        `);
        await writeAudit(tx, {
          actor: principal,
          action: 'version.delete',
          targetType: 'budget_version',
          targetId: null,
          // The count is recorded because the cascade is the point: this is a
          // destructive action and the audit entry should say how destructive.
          detail:
            `Deleted ${version.kind} "${version.label}" (${key}) ` +
            `and its ${version.amountCount} amounts`,
          kind: 'governance',
          request,
        });
      });

      return { ok: true };
    },
  );

  /** FR-080: two versions side by side, grouped the way FR-060 groups. */
  app.get('/api/reports/compare', { config: authenticatedRoute }, async (request) => {
    const query = parse(
      z.object({
        base: schemas.versionKey.default('working'),
        against: schemas.versionKey,
      }),
      request.query,
    );

    for (const key of [query.base, query.against]) {
      if (!(await getVersion(db, year, key))) throw notFound('no such budget version');
    }

    const ids = await visibleEntityIds(db, request, config.RESIDENCY_REGION);
    if (ids.length === 0) {
      const zero = { key: 'total', label: 'Group total', base: '0.0000', against: '0.0000', delta: '0.0000' };
      return { base: query.base, against: query.against, total: zero, entities: [], categories: [] };
    }

    const cycle = await loadCycle(db, year);
    const comparison = await compareVersions(
      db, ids, year, cycle.headcount_planning, periodsIn(cycle.granularity),
      query.base, query.against,
    );

    const render = (row: { key: string; label: string; base: Money; against: Money; delta: Money }) => ({
      key: row.key,
      label: row.label,
      base: row.base.toString(),
      against: row.against.toString(),
      delta: row.delta.toString(),
    });

    return {
      base: comparison.base,
      against: comparison.against,
      total: render(comparison.total),
      entities: comparison.entities.map(render),
      categories: comparison.categories.map(render),
    };
  });
}

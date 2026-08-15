/**
 * Audit trail (FR-071, FR-072).
 *
 * There is one endpoint, not two. Whether the caller sees everything or only
 * their own events is decided from the capability matrix and pushed into the
 * query — a manager's request never loads another actor's rows and then hides
 * them, which is the failure mode FR-071 calls out explicitly.
 */

import type { FastifyInstance } from 'fastify';
import { can, schemas } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { authenticatedRoute, principalOf } from '../http/guard.ts';
import { parse } from '../http/validate.ts';
import { readAudit } from '../services/audit.ts';

export async function registerAuditRoutes(
  app: FastifyInstance,
  db: Db,
  _config: AppConfig,
): Promise<void> {
  app.get('/api/audit', { config: authenticatedRoute }, async (request) => {
    const principal = principalOf(request);
    const query = parse(schemas.auditQuerySchema, request.query);

    // FR-071: 'audit.viewAll' is Admin and CFO only; everyone else falls back
    // to 'audit.viewOwn', which every role holds.
    const viewAll = can(principal.role, 'audit.viewAll');

    const events = await readAudit(db, principal, viewAll, {
      kind: query.kind,
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    });

    return { scope: viewAll ? 'all' : 'own', events };
  });
}

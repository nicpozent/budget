/**
 * Application assembly. Order matters here, so it is written out explicitly
 * rather than hidden behind a plugin auto-loader:
 *
 *   1. security headers   — set before anything can produce a response
 *   2. route declarations — refuse to register an undeclared route (SEC-010)
 *   3. rate limiting      — before authentication, so an unauthenticated flood
 *                           cannot exhaust database connections (SEC-013)
 *   4. auth guard         — session, CSRF, capability, step-up
 *   5. routes
 *   6. audit completeness — after the handler, before the response is sent
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { Db } from './db/pool.ts';
import { AppError, internal } from './http/errors.ts';
import { registerSecurityHeaders } from './http/security.ts';
import { registerAuthGuard, registerRouteDeclarationCheck } from './http/guard.ts';
import { registerAuditCompletenessCheck } from './services/audit.ts';
import { registerObservability } from './observability/index.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMetaRoutes } from './routes/meta.ts';
import { registerLineRoutes } from './routes/lines.ts';
import { registerWorkflowRoutes } from './routes/workflow.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerTemplateRoutes } from './routes/template.ts';
import { registerApprovalRoutes } from './routes/approvals.ts';
import { registerLedgerRoutes } from './routes/ledger.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerAuditRoutes } from './routes/audit.ts';
import { registerShellRoutes } from './routes/shell.ts';

export interface AppDeps {
  db: Db;
  config: AppConfig;
}

export async function buildApp({ db, config }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Bound the request body. A finance grid posts small JSON; anything larger
    // is either a mistake or an attempt to exhaust memory.
    bodyLimit: 512 * 1024,
    // Trust the proxy only for the immediate hop, so a client-supplied
    // X-Forwarded-For cannot spoof the address used for rate limiting.
    trustProxy: 1,
    genReqId: () => randomUUID(),
    disableRequestLogging: false,
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
    },
  });

  registerSecurityHeaders(app, config);
  registerRouteDeclarationCheck(app);

  await app.register(cookie, {
    parseOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
    },
  });

  // Registering the plugin is what activates per-route `rateLimit` config too,
  // so the switch skips registration entirely rather than raising the ceiling.
  if (config.RATE_LIMIT === 'on') {
    await app.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: '1 minute',
      // Per authenticated user where we know them, per address otherwise, so
      // one noisy tenant behind a shared egress cannot lock out the rest
      // (SEC-013).
      keyGenerator: (request) => request.principal?.userId ?? request.ip,
      addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
    });
  }

  registerAuthGuard(app, db, config);
  registerAuditCompletenessCheck(app, !config.isProduction);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // The internal message is logged; only the safe message is serialised.
      request.log.warn(
        { event: 'request.rejected', code: error.code, reason: error.message },
        'request rejected',
      );
      return reply.status(error.status).send(error.toBody());
    }

    // Framework-level failures that are the caller's fault — an unparseable
    // body, an oversized payload, a rate-limit trip — arrive here carrying
    // their own 4xx. Reporting those as 500 would be wrong twice: it tells the
    // caller we broke when they did, and it pages someone for a malformed
    // request. They are translated to a safe 4xx; the detail still only goes
    // to the log.
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    if (typeof frameworkStatus === 'number' && frameworkStatus >= 400 && frameworkStatus < 500) {
      const code = frameworkStatus === 429 ? 'rate_limited' : 'bad_request';
      request.log.warn(
        {
          event: 'request.rejected',
          code,
          reason: error instanceof Error ? error.message : 'framework error',
        },
        'request rejected',
      );
      return reply.status(frameworkStatus).send(new AppError(code).toBody());
    }

    request.log.error({ err: error, event: 'request.failed' }, 'unhandled error');
    return reply.status(500).send(internal().toBody());
  });

  // No route matched. The guard recognises this case by the absent route url
  // and lets it through to here rather than treating it as an undeclared route.
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(new AppError('not_found').toBody()),
  );

  // Before the routes, so the request hooks are in place for all of them.
  registerObservability(app, config);

  await registerAuthRoutes(app, db, config);
  await registerMetaRoutes(app, db, config);
  await registerLineRoutes(app, db, config);
  await registerWorkflowRoutes(app, db, config);
  await registerAdminRoutes(app, db, config);
  await registerTemplateRoutes(app, db, config);
  await registerApprovalRoutes(app, db, config);
  await registerLedgerRoutes(app, db, config);
  await registerReportRoutes(app, db, config);
  await registerAuditRoutes(app, db, config);
  await registerShellRoutes(app, config);

  return app;
}

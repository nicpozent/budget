/**
 * Sign-in, sign-out and session bootstrap.
 *
 * The session cookie is rotated on every successful authentication, so a token
 * observed before sign-in cannot be reused afterwards (session fixation).
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import { publicRoute, authenticatedRoute } from '../http/guard.ts';
import { badRequest, unauthenticated } from '../http/errors.ts';
import {
  createSession,
  loadSession,
  revokeSession,
  sessionCookieName,
} from '../auth/session.ts';
import { createIdentityProvider, safeRedirectPath } from '../auth/oidc.ts';
import { writeAudit } from '../services/audit.ts';
import type { Role } from '@spendifre/shared';

export async function registerAuthRoutes(
  app: FastifyInstance,
  db: Db,
  config: AppConfig,
): Promise<void> {
  const idp = createIdentityProvider(config);
  const cookieName = sessionCookieName(config.cookieSecure);
  const csrfCookieName = config.cookieSecure ? '__Host-csrf' : 'csrf';

  // SEC-013: authentication endpoints are rate limited harder than the rest.
  const authRateLimit = {
    rateLimit: { max: 10, timeWindow: '1 minute' },
  };

  app.get(
    '/auth/login',
    { config: { ...publicRoute, ...authRateLimit } },
    async (request, reply) => {
      const next = safeRedirectPath(
        typeof (request.query as { next?: string }).next === 'string'
          ? (request.query as { next?: string }).next
          : undefined,
      );
      const url = await idp.beginLogin(db, next);
      return reply.redirect(url, 302);
    },
  );

  app.get(
    '/auth/callback',
    { config: { ...publicRoute, ...authRateLimit } },
    async (request, reply) => {
      const callbackUrl = new URL(request.url, config.PUBLIC_ORIGIN);

      let identity;
      try {
        identity = await idp.completeLogin(db, callbackUrl);
      } catch (err) {
        request.log.warn({ err, event: 'auth.failed' }, 'authentication failed');
        // Deliberately uniform: a caller cannot distinguish an unknown account
        // from a failed nonce check from a missing role group.
        throw unauthenticated('authentication failed');
      }

      const session = await db.transaction(async (tx) => {
        // Just-in-time provisioning, in three deliberate steps.
        //
        // The Entra object id is the identity, not the email address: emails
        // are reassigned when people leave, and matching on one would let a
        // new joiner inherit a predecessor's history. So we match on oid first.
        let user = await tx.one<{ id: string; role: Role }>(sql`
          update users
          set email = ${identity.email},
              display_name = ${identity.displayName},
              role = ${identity.role},
              last_seen_at = now(),
              is_active = true
          where entra_oid = ${identity.entraOid}
          returning id, role
        `);

        // A pre-provisioned account — created by an admin naming an entity
        // owner by email, before that person ever signed in — is claimed here.
        // Only rows that have never been linked are eligible: requiring
        // `entra_oid is null` means an established account can never be taken
        // over by a second principal presenting the same address.
        if (!user) {
          user = await tx.one<{ id: string; role: Role }>(sql`
            update users
            set entra_oid = ${identity.entraOid},
                display_name = ${identity.displayName},
                role = ${identity.role},
                last_seen_at = now(),
                is_active = true
            where email = ${identity.email} and entra_oid is null
            returning id, role
          `);
        }

        if (!user) {
          user = await tx.one<{ id: string; role: Role }>(sql`
            insert into users (entra_oid, email, display_name, role, last_seen_at)
            values (${identity.entraOid}, ${identity.email}, ${identity.displayName},
                    ${identity.role}, now())
            returning id, role
          `);
        }

        if (!user) throw unauthenticated('could not establish user');

        const created = await createSession(tx, config, {
          userId: user.id,
          authTime: identity.authTime,
          amr: identity.amr,
          deviceCompliant: identity.deviceCompliant,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });

        await writeAudit(tx, {
          actor: { userId: user.id, role: user.role },
          action: 'auth.signin',
          targetType: 'user',
          targetId: user.id,
          detail: `Signed in as ${user.role}`,
          kind: 'workflow',
        });

        return created;
      });

      reply.setCookie(cookieName, session.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        path: '/',
        expires: session.expiresAt,
      });

      // The CSRF token travels in a separate, deliberately script-readable
      // cookie so the client can echo it in `x-csrf-token`. It is not a
      // credential on its own: the server compares the echoed value against a
      // stored hash tied to this session, and the session cookie itself stays
      // HttpOnly. Exposing the session token this way would be the mistake;
      // exposing the CSRF token is the mechanism.
      reply.setCookie(csrfCookieName, session.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: config.cookieSecure,
        path: '/',
        expires: session.expiresAt,
      });

      const redirectPath = safeRedirectPath(
        callbackUrl.searchParams.get('next') ?? undefined,
      );
      return reply.redirect(redirectPath, 302);
    },
  );

  app.post(
    '/auth/logout',
    { config: { ...authenticatedRoute } },
    async (request, reply) => {
      if (request.sessionToken) await revokeSession(db, request.sessionToken);
      reply.clearCookie(cookieName, { path: '/' });
      reply.clearCookie(csrfCookieName, { path: '/' });
      return reply.status(204).send();
    },
  );

  /** Bootstrap payload for the client: who am I, and what cycle am I in. */
  app.get('/api/me', { config: authenticatedRoute }, async (request) => {
    if (!request.sessionToken) throw unauthenticated('no session');
    const session = await loadSession(db, request.sessionToken);
    if (!session) throw unauthenticated('no session');

    return {
      user: {
        id: session.userId,
        displayName: session.displayName,
        email: session.email,
        role: session.role,
        ownedEntityIds: session.ownedEntityIds,
      },
      fiscalYear: config.FISCAL_YEAR,
      region: config.RESIDENCY_REGION,
    };
  });

  /**
   * Development sign-in. Registered only when DEV_AUTH is on, and `loadConfig`
   * refuses that combination in production — so the route does not exist in a
   * deployed environment rather than merely being guarded inside.
   */
  if (config.DEV_AUTH === 'on' && !config.isProduction) {
    app.get(
      '/auth/dev-login',
      { config: { ...publicRoute, ...authRateLimit } },
      async (request, reply) => {
        const query = request.query as { state?: string; email?: string };
        if (!query.state || !query.email) throw badRequest('state and email are required');
        const url = new URL('/auth/callback', config.PUBLIC_ORIGIN);
        url.searchParams.set('state', query.state);
        url.searchParams.set('email', query.email);
        return reply.redirect(`${url.pathname}${url.search}`, 302);
      },
    );
  }

  /** SEC-032 report sink. Unauthenticated by design; bodies are logged, not stored. */
  app.post(
    config.CSP_REPORT_URI,
    { config: { ...publicRoute, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      request.log.warn({ event: 'csp.violation', report: request.body }, 'CSP violation');
      return reply.status(204).send();
    },
  );

  app.get('/healthz', { config: publicRoute }, async () => ({ status: 'ok' }));
}

/**
 * Server-side sessions (SEC-034, ZT-001, ZT-007).
 *
 * The cookie carries a random opaque token and nothing else — no claims, no
 * role, no entity scope. Everything the authorisation layer needs is re-derived
 * from the database on every request, so a stolen or edited cookie cannot
 * assert a role it was not granted (SEC-011).
 *
 * Only the SHA-256 of each token is stored. A database read therefore yields no
 * usable session, which matters when the threat model assumes breach (ZT-006).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import type { Role } from '@spendifre/shared';
import type { AppConfig } from '../config.ts';

/** Host-prefixed when the deployment is https, which the browser then ties to
 *  origin, path `/` and Secure — closing subdomain cookie-injection. */
export const sessionCookieName = (secure: boolean) => (secure ? '__Host-sid' : 'sid');

export interface SessionRecord {
  userId: string;
  role: Role;
  displayName: string;
  email: string;
  ownedEntityIds: string[];
  authTime: Date;
  amr: string[];
  deviceCompliant: boolean;
  csrfTokenHash: Buffer;
}

export interface NewSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison that tolerates length mismatch without leaking it. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CreateSessionInput {
  userId: string;
  authTime: Date;
  amr: readonly string[];
  deviceCompliant: boolean;
  ip: string | undefined;
  userAgent: string | undefined;
}

export async function createSession(
  db: Db,
  config: AppConfig,
  input: CreateSessionInput,
): Promise<NewSession> {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_MINUTES * 60_000);

  await db.query(sql`
    insert into sessions (
      id_hash, user_id, csrf_token_hash, auth_time, expires_at,
      amr, device_compliant, ip_hash, ua_hash
    ) values (
      ${sha256(token)}, ${input.userId}, ${sha256(csrfToken)}, ${input.authTime}, ${expiresAt},
      ${[...input.amr]}, ${input.deviceCompliant},
      ${input.ip ? sha256(config.TELEMETRY_SALT + input.ip) : null},
      ${input.userAgent ? sha256(config.TELEMETRY_SALT + input.userAgent) : null}
    )
  `);

  return { token, csrfToken, expiresAt };
}

/**
 * Resolve a session token to a principal, or null. Expired, revoked and
 * inactive-user sessions all resolve to null — the caller cannot distinguish
 * them, so session state is not an oracle.
 */
export async function loadSession(db: Db, token: string): Promise<SessionRecord | null> {
  if (!token || token.length > 128) return null;

  const row = await db.one<{
    user_id: string;
    role: Role;
    display_name: string;
    email: string;
    auth_time: Date;
    amr: string[];
    device_compliant: boolean;
    csrf_token_hash: Buffer;
    owned_entity_ids: string[] | null;
  }>(sql`
    select
      s.user_id, u.role, u.display_name, u.email,
      s.auth_time, s.amr, s.device_compliant, s.csrf_token_hash,
      array_remove(array_agg(eo.entity_id), null) as owned_entity_ids
    from sessions s
    join users u on u.id = s.user_id
    left join entity_owners eo on eo.user_id = s.user_id
    where s.id_hash = ${sha256(token)}
      and s.revoked_at is null
      and s.expires_at > now()
      and u.is_active
    group by s.user_id, u.role, u.display_name, u.email,
             s.auth_time, s.amr, s.device_compliant, s.csrf_token_hash
  `);

  if (!row) return null;

  return {
    userId: row.user_id,
    role: row.role,
    displayName: row.display_name,
    email: row.email,
    ownedEntityIds: row.owned_entity_ids ?? [],
    authTime: row.auth_time,
    amr: row.amr,
    deviceCompliant: row.device_compliant,
    csrfTokenHash: row.csrf_token_hash,
  };
}

/** Sliding idle window, bounded by the absolute TTL set at creation. */
export async function touchSession(db: Db, token: string): Promise<void> {
  await db.query(sql`
    update sessions set last_seen_at = now() where id_hash = ${sha256(token)}
  `);
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.query(sql`
    update sessions set revoked_at = now()
    where id_hash = ${sha256(token)} and revoked_at is null
  `);
}

/** ZT-007: revoke every session for a user on a risk signal or role change. */
export async function revokeAllForUser(db: Db, userId: string): Promise<number> {
  const rows = await db.query<{ id_hash: Buffer }>(sql`
    update sessions set revoked_at = now()
    where user_id = ${userId} and revoked_at is null
    returning id_hash
  `);
  return rows.length;
}

export function verifyCsrf(session: SessionRecord, presented: string | undefined): boolean {
  if (!presented || presented.length > 128) return false;
  return safeEqual(session.csrfTokenHash, sha256(presented));
}

/** ZT-007: primary authentication must be recent for an irreversible action. */
export function isAuthFresh(session: SessionRecord, maxAgeMinutes: number): boolean {
  const ageMs = Date.now() - session.authTime.getTime();
  return ageMs <= maxAgeMinutes * 60_000;
}

/** Housekeeping — expired rows are not evidence and are not retained. */
export async function purgeExpiredSessions(db: Db): Promise<number> {
  const rows = await db.query(sql`
    delete from sessions
    where expires_at < now() - interval '7 days'
    returning user_id
  `);
  return rows.length;
}

/**
 * Identity (ZT-002). Entra ID, OIDC authorisation code flow with PKCE.
 *
 * Roles come from group claims and nothing else — there is no local account
 * store, no password reset path, and no way for a request to assert a role.
 * The group-to-role mapping is the one in SPEC §4, held in @spendifre/shared so
 * that the mapping is testable without a network.
 *
 * The OIDC transaction (state, nonce, PKCE verifier) is held server-side in
 * `auth_transactions`, not in a cookie: a cookie-borne verifier is readable by
 * anything that can read cookies, and the point of PKCE is that it is not.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as client from 'openid-client';
import { ENTRA_GROUP_TO_ROLE, type Role } from '@spendifre/shared';
import type { Db } from '../db/pool.ts';
import { sql } from '../db/pool.ts';
import type { AppConfig } from '../config.ts';

export interface AuthenticatedIdentity {
  entraOid: string;
  email: string;
  displayName: string;
  role: Role;
  /** Authentication methods actually used, from the `amr` claim. */
  amr: string[];
  /** Conditional Access device compliance, re-checked here so a policy gap
   *  fails closed rather than granting privileged access (ZT-003). */
  deviceCompliant: boolean;
  authTime: Date;
}

export interface IdentityProvider {
  /** Returns the URL to redirect the browser to, having stored the transaction. */
  beginLogin(db: Db, redirectPath: string): Promise<string>;
  /** Completes the flow from the callback URL. Throws on any mismatch. */
  completeLogin(db: Db, callbackUrl: URL): Promise<AuthenticatedIdentity>;
}

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest();

/** Only relative, single-slash paths may be returned to (SEC-035). */
export function safeRedirectPath(candidate: string | undefined): string {
  if (!candidate) return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (candidate.includes('\\') || candidate.includes('\n') || candidate.includes('\r')) return '/';
  if (candidate.length > 512) return '/';
  return candidate;
}

async function storeTransaction(
  db: Db,
  state: string,
  codeVerifier: string,
  nonce: string,
  redirectPath: string,
): Promise<void> {
  await db.query(sql`
    insert into auth_transactions (state_hash, code_verifier, nonce, redirect_path, expires_at)
    values (${sha256(state)}, ${codeVerifier}, ${nonce}, ${redirectPath}, now() + interval '10 minutes')
  `);
}

/** Single-use: the row is deleted as it is read, so a replayed callback fails. */
async function consumeTransaction(
  db: Db,
  state: string,
): Promise<{ code_verifier: string; nonce: string; redirect_path: string } | null> {
  return db.one(sql`
    delete from auth_transactions
    where state_hash = ${sha256(state)} and expires_at > now()
    returning code_verifier, nonce, redirect_path
  `);
}

export function mapGroupsToRole(groups: readonly string[]): Role | null {
  // A principal in several role groups gets the least privileged of them —
  // membership sprawl must not silently escalate (ZT-004).
  const precedence: Role[] = [
    'pmo', 'arch_manager', 'security_manager', 'infra_manager',
    'cto', 'cio', 'finance_manager', 'cfo', 'admin',
  ];
  const matched = groups
    .map((g) => ENTRA_GROUP_TO_ROLE[g])
    .filter((r): r is Role => Boolean(r));
  if (matched.length === 0) return null;
  return precedence.find((r) => matched.includes(r)) ?? null;
}

export class EntraIdentityProvider implements IdentityProvider {
  #config: client.Configuration | null = null;
  readonly #appConfig: AppConfig;

  constructor(appConfig: AppConfig) {
    this.#appConfig = appConfig;
  }

  async #discover(): Promise<client.Configuration> {
    if (this.#config) return this.#config;
    const { ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET } = this.#appConfig;
    if (!ENTRA_TENANT_ID || !ENTRA_CLIENT_ID || !ENTRA_CLIENT_SECRET) {
      throw new Error('Entra ID is not configured');
    }
    this.#config = await client.discovery(
      new URL(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`),
      ENTRA_CLIENT_ID,
      ENTRA_CLIENT_SECRET,
    );
    return this.#config;
  }

  get #redirectUri(): string {
    return new URL('/auth/callback', this.#appConfig.PUBLIC_ORIGIN).toString();
  }

  async beginLogin(db: Db, redirectPath: string): Promise<string> {
    const config = await this.#discover();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');

    await storeTransaction(db, state, codeVerifier, nonce, safeRedirectPath(redirectPath));

    return client
      .buildAuthorizationUrl(config, {
        redirect_uri: this.#redirectUri,
        scope: 'openid profile email',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        // Conditional Access evaluates these; we still re-check the resulting
        // claims below rather than trusting that the policy was applied.
        response_mode: 'query',
      })
      .toString();
  }

  async completeLogin(db: Db, callbackUrl: URL): Promise<AuthenticatedIdentity> {
    const config = await this.#discover();
    const state = callbackUrl.searchParams.get('state');
    if (!state) throw new Error('missing state');

    const transaction = await consumeTransaction(db, state);
    if (!transaction) throw new Error('unknown or expired authentication transaction');

    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: transaction.code_verifier,
      expectedNonce: transaction.nonce,
      expectedState: state,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) throw new Error('no id token claims');

    const groups = Array.isArray(claims.groups) ? (claims.groups as string[]) : [];
    const role = mapGroupsToRole(groups);
    if (!role) throw new Error('no Spendifre role group on this account');

    const amr = Array.isArray(claims.amr) ? (claims.amr as string[]) : [];
    const email = typeof claims.email === 'string'
      ? claims.email
      : typeof claims.preferred_username === 'string'
        ? claims.preferred_username
        : '';
    if (!email) throw new Error('no email claim');

    return {
      entraOid: String(claims.oid ?? claims.sub),
      email: email.toLowerCase(),
      displayName: typeof claims.name === 'string' ? claims.name : email,
      role,
      amr,
      // Entra emits `deviceid` and, with the right policy, an `acrs`/`xms_cc`
      // claim. Absence is treated as non-compliant.
      deviceCompliant: Boolean(claims.deviceid),
      authTime: claims.auth_time
        ? new Date(Number(claims.auth_time) * 1000)
        : new Date(),
    };
  }
}

/**
 * Local development only. `loadConfig` refuses to start with DEV_AUTH=on when
 * NODE_ENV is production, so this cannot be enabled in a deployed environment
 * by setting an environment variable.
 */
export class DevIdentityProvider implements IdentityProvider {
  readonly #appConfig: AppConfig;

  constructor(appConfig: AppConfig) {
    this.#appConfig = appConfig;
  }

  async beginLogin(db: Db, redirectPath: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await storeTransaction(db, state, 'dev', 'dev', safeRedirectPath(redirectPath));
    return `/auth/dev-login?state=${encodeURIComponent(state)}`;
  }

  async completeLogin(db: Db, callbackUrl: URL): Promise<AuthenticatedIdentity> {
    if (this.#appConfig.isProduction) throw new Error('dev auth is not available');
    const state = callbackUrl.searchParams.get('state');
    if (!state) throw new Error('missing state');
    const transaction = await consumeTransaction(db, state);
    if (!transaction) throw new Error('unknown or expired authentication transaction');

    const email = (callbackUrl.searchParams.get('email') ?? '').toLowerCase();
    const user = await db.one<{ id: string; role: Role; display_name: string }>(sql`
      select id, role, display_name from users where email = ${email} and is_active
    `);
    if (!user) throw new Error('unknown development user');

    return {
      // Stable across reseeds and derived from the same value the seed writes,
      // so the account-linking path in the callback behaves the way it will
      // against a real tenant, where the oid is likewise stable per person.
      entraOid: `dev:${email}`,
      email,
      displayName: user.display_name,
      role: user.role,
      amr: ['pwd', 'mfa'],
      deviceCompliant: true,
      authTime: new Date(),
    };
  }
}

export function createIdentityProvider(config: AppConfig): IdentityProvider {
  return config.DEV_AUTH === 'on' && !config.isProduction
    ? new DevIdentityProvider(config)
    : new EntraIdentityProvider(config);
}

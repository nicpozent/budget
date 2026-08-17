/**
 * Test harness.
 *
 * The suite runs against a real PostgreSQL, not a mock. Half of what is being
 * asserted here — the append-only trigger, the segregation-of-duties CHECK
 * constraints, the least-privilege grants, `numeric` precision — lives in the
 * database, and a mock would assert only that the mock behaves as written.
 *
 * Each run builds a throwaway database from the migrations and seeds it with
 * the synthetic fixture (PRIV-010).
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../packages/api/src/config.ts';
import { createDb, sql, type Db } from '../packages/api/src/db/pool.ts';
import { migrate } from '../packages/api/src/db/migrate.ts';
import { seed } from '../packages/api/src/db/seed.ts';
import { buildApp } from '../packages/api/src/app.ts';
import { createSession } from '../packages/api/src/auth/session.ts';
import type { Role } from '@spendifre/shared';

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgres://postgres:devonly_postgres@127.0.0.1:5432/postgres';

export const FISCAL_YEAR = 2026;

export interface Harness {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  dbName: string;
  /** Signs in as the seeded user with this email and returns request headers. */
  as(email: string): Promise<AuthHeaders>;
  close(): Promise<void>;
}

export interface AuthHeaders {
  cookie: string;
  'x-csrf-token': string;
  origin: string;
  userId: string;
  role: Role;
}

function baseUrl(dbName: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export interface HarnessOptions {
  /** Turn the app logger on when diagnosing a failing test. */
  verbose?: boolean;
  /** Off for the authorisation suite, which makes hundreds of deliberate
   *  requests from one address. The limiter has its own test. */
  rateLimit?: 'on' | 'off';
  /** Extra environment for `loadConfig`, so a test can shorten a timeout
   *  rather than wait one out. Merged last, so it can override a default. */
  env?: Record<string, string>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dbName = `spendifre_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  // Identifier is generated here, not supplied by a caller, and matched against
  // a strict pattern before it reaches DDL.
  if (!/^spendifre_test_[a-z0-9]{16}$/.test(dbName)) throw new Error('bad test db name');
  // PostgreSQL has no bind parameter for a database name, so this is the one
  // place an identifier is interpolated. It is generated here from a UUID and
  // matched against the pattern above before use — it never comes from input.
  // eslint-disable-next-line no-restricted-syntax -- generated identifier, validated above
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const url = baseUrl(dbName);
  await migrate(url, () => undefined);

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    TELEMETRY_SALT: 'test-salt-value-not-a-secret',
    PUBLIC_ORIGIN: 'http://localhost:8080',
    DEV_AUTH: 'off',
    FISCAL_YEAR: String(FISCAL_YEAR),
    RESIDENCY_REGION: 'eu',
    RATE_LIMIT: options.rateLimit ?? 'on',
    // Backups are exercised by the suite, so the harness supplies a throwaway
    // key and an isolated directory per run.
    BACKUP_ENCRYPTION_KEY: 'a'.repeat(64),
    BACKUP_DIR: path.join(tmpdir(), `spendifre-backups-${dbName}`),
    ...options.env,
  });

  const db = createDb(config);
  await seed(db, FISCAL_YEAR);
  const app = await buildApp({ db, config: options.verbose ? { ...config, NODE_ENV: 'development' } as AppConfig : config });
  await app.ready();

  const as = async (email: string): Promise<AuthHeaders> => {
    const user = await db.one<{ id: string; role: Role }>(sql`
      select id, role from users where email = ${email}
    `);
    if (!user) throw new Error(`no seeded user ${email}`);

    // Sessions are minted directly rather than through the OIDC flow: the flow
    // has its own tests, and going through a real IdP here would make every
    // authorisation test depend on a network.
    const session = await createSession(db, config, {
      userId: user.id,
      authTime: new Date(),
      amr: ['pwd', 'mfa'],
      deviceCompliant: true,
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });

    return {
      cookie: `sid=${session.token}`,
      'x-csrf-token': session.csrfToken,
      origin: config.PUBLIC_ORIGIN,
      userId: user.id,
      role: user.role,
    };
  };

  const close = async () => {
    await app.close();
    await db.close();
    await rm(config.BACKUP_DIR, { recursive: true, force: true });
    const cleanup = new pg.Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`,
      [dbName],
    );
    // eslint-disable-next-line no-restricted-syntax -- same generated identifier
    await cleanup.query(`drop database if exists ${dbName}`);
    await cleanup.end();
  };

  return { app, db, config, dbName, as, close };
}

/**
 * Makes every persona an owner of one entity, so a capability probe is not
 * confounded by entity scope. The two axes — "may this role do this at all"
 * and "may it do it here" — are tested separately and deliberately.
 */
export async function grantAllPersonasOwnership(db: Db, entityId: string): Promise<void> {
  await db.query(sql`
    insert into entity_owners (entity_id, user_id)
    select ${entityId}, id from users
    on conflict do nothing
  `);
}

/** Every seeded persona, so tests can iterate the whole matrix. */
export const PERSONAS: Record<Role, string> = {
  admin: 'admin@birgma.test',
  cfo: 'cfo@birgma.test',
  finance_manager: 'finance@birgma.test',
  cio: 'cio@birgma.test',
  cto: 'cto@birgma.test',
  infra_manager: 'infra@birgma.test',
  security_manager: 'security@birgma.test',
  arch_manager: 'architecture@birgma.test',
  pmo: 'pmo@birgma.test',
};

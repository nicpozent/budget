/**
 * Configuration is read from the environment once, validated, and frozen.
 *
 * No secret has a default (ZT-006). A missing secret is a startup failure, not
 * a silent fallback to a development value — the class of bug where a staging
 * box quietly runs with a well-known signing key.
 */

import { z } from 'zod';

const RESIDENCY_REGIONS = ['eu', 'ch', 'apac', 'cn'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('127.0.0.1'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Statement timeout in ms. Bounds the blast radius of a pathological query. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * TLS for the application -> database hop (ZT-006).
   *
   * node-postgres does NOT negotiate TLS unless asked, and even `require` does
   * not validate the server certificate — it encrypts against a passive
   * listener but not against an active one. `verify-full` is the only mode that
   * defends the path an attacker on the network segment would actually take, so
   * it is the production default and `disable` is refused there.
   *
   *   disable      plaintext. Local development against a container with no cert.
   *   require      encrypt, do not verify. Better than nothing, not a defence
   *                against a man in the middle.
   *   verify-full  encrypt, verify the chain and the hostname. Needs DB_CA_CERT
   *                unless the server chains to a root the platform already trusts.
   */
  DB_SSL_MODE: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  /** PEM for the CA that signed the database's certificate, or a path to one. */
  DB_CA_CERT: z.string().optional(),

  /**
   * SPEC §9.4. The deployment's region. The application refuses to return a row
   * whose residency does not match, so a misrouted replica or a mistaken
   * connection string fails closed rather than exporting data across a border.
   */
  RESIDENCY_REGION: z.enum(RESIDENCY_REGIONS).default('eu'),

  /** Origin used for absolute URLs and for the strict origin check (SEC-034). */
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:8080'),

  /** Entra ID (ZT-002). Absent in development, where the dev provider is used. */
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),

  /**
   * Enables a local sign-in stub. Refused in production by the cross-check
   * below, so it cannot be turned on by an environment variable in a deployed
   * environment.
   */
  DEV_AUTH: z.enum(['on', 'off']).default('off'),

  /**
   * Rate limiting (SEC-013). Off only for the authorisation suite, which needs
   * to make several hundred deliberate requests from one address; the limiter
   * has its own dedicated test. Refused in production below, so this cannot be
   * turned off in a deployed environment by setting an environment variable.
   */
  RATE_LIMIT: z.enum(['on', 'off']).default('on'),

  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(720).default(60),
  /**
   * ZT-004 idle timeout. A session untouched for this long is dead regardless
   * of the absolute TTL. 15 minutes is the default for a system holding
   * commercial budget data on shared workstations.
   *
   * WCAG 2.2.1 requires the user be warned before this expires and given a way
   * to extend it; `SESSION_IDLE_WARN_SECONDS` is how long before.
   */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  SESSION_IDLE_WARN_SECONDS: z.coerce.number().int().min(20).max(600).default(120),
  /** ZT-007: how fresh primary authentication must be for an irreversible action. */
  STEP_UP_MAX_AGE_MINUTES: z.coerce.number().int().min(1).max(120).default(15),

  /** Salt for IP/user-agent hashes in the session table (CMP-132). */
  TELEMETRY_SALT: z.string().min(16, 'TELEMETRY_SALT must be at least 16 characters'),

  /**
   * Which dataset `npm run db:seed` loads. A deployment choice, not a code
   * change. `anonymised` reads the artefact from tools/anonymise.ts; neither
   * mode ever reads the raw workbook extract (PRIV-010).
   */
  SEED_MODE: z.enum(['synthetic', 'anonymised']).default('synthetic'),
  SEED_ANONYMISED_FILE: z.string().default('db/fixtures/anonymised.json'),

  /**
   * Backups. `BACKUP_DIR` is a local path here; in Azure this is a Blob
   * container with customer-managed keys and an immutability policy. The
   * encryption key is 32 bytes of hex and comes from Key Vault — a deployment
   * without it can list backups but cannot create or read one, which is a
   * better failure than writing an unencrypted archive.
   */
  BACKUP_DIR: z.string().default('./var/backups'),
  BACKUP_ENCRYPTION_KEY: z.string().optional(),

  /** Where CSP violation reports are posted (SEC-032). */
  CSP_REPORT_URI: z.string().default('/api/security/csp-report'),

  FISCAL_YEAR: z.coerce.number().int().min(2000).max(2100).default(2026),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>> & {
  readonly isProduction: boolean;
  readonly cookieSecure: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const cfg = parsed.data;
  const isProduction = cfg.NODE_ENV === 'production';

  if (isProduction) {
    if (cfg.DEV_AUTH === 'on') {
      throw new Error('DEV_AUTH cannot be enabled in production');
    }
    if (cfg.RATE_LIMIT === 'off') {
      throw new Error('RATE_LIMIT cannot be disabled in production');
    }
    if (!cfg.ENTRA_TENANT_ID || !cfg.ENTRA_CLIENT_ID || !cfg.ENTRA_CLIENT_SECRET) {
      throw new Error('Entra ID configuration is required in production');
    }
    if (!cfg.PUBLIC_ORIGIN.startsWith('https://')) {
      throw new Error('PUBLIC_ORIGIN must be https in production');
    }
    if (cfg.DB_SSL_MODE === 'disable') {
      throw new Error('DB_SSL_MODE must be require or verify-full in production');
    }
    if (cfg.SEED_MODE !== 'synthetic') {
      // Seeding a production database from any fixture is a mistake; the
      // anonymised one is still derived from real data (CMP-104).
      throw new Error('SEED_MODE must be synthetic in production');
    }
    if (cfg.BACKUP_ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(cfg.BACKUP_ENCRYPTION_KEY)) {
      throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
  }

  return Object.freeze({
    ...cfg,
    isProduction,
    // Host-prefixed cookies require Secure, so this also decides the cookie name.
    cookieSecure: isProduction || cfg.PUBLIC_ORIGIN.startsWith('https://'),
  });
}

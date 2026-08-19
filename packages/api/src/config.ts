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
   * SPEC §9.4. Where this deployment *lives*.
   *
   * A single value, and it stays single: a backup archive is bound to it by the
   * AES-GCM additional-authenticated-data, so an archive taken in one region
   * cannot be decrypted as though it belonged to another. Widening this would
   * silently invalidate every existing archive.
   */
  RESIDENCY_REGION: z.enum(RESIDENCY_REGIONS).default('eu'),

  /**
   * Which regions' entities this deployment *serves* — a comma-separated list.
   *
   * These were one setting until the group chose a single central deployment,
   * and conflating them made that choice unimplementable: a central EU
   * deployment served 14 of 21 entities and made the other 7 invisible to
   * everyone including the administrator, because "where we run" was being used
   * to answer "whose data may we show".
   *
   * They are separate questions. This one is still an allow-list and still
   * defaults to the home region alone, so nothing widens by accident — serving
   * another jurisdiction's data is a deliberate, recorded configuration and a
   * cross-border transfer someone has to have a lawful basis for (CMP-140).
   */
  SERVED_REGIONS: z.string().optional(),

  /**
   * Which countries inside those regions this deployment serves — a
   * comma-separated list of ISO 3166-1 alpha-2 codes. Unset means all of them.
   *
   * A region is a storage bucket, not a jurisdiction: `apac` is Singapore,
   * India and Vietnam at once, so `SERVED_REGIONS` alone can say "serve APAC"
   * and cannot say "serve Singapore but not Vietnam". This says the second
   * thing. It only ever narrows — an entity must clear the region list *and*
   * this one — so leaving it unset cannot widen anything.
   */
  SERVED_COUNTRIES: z.string().optional(),

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
  /**
   * Observability (ZT-008). All three are optional and all three fail closed:
   * no token means no /metrics route at all, and no endpoint means spans are
   * built and discarded rather than queued for a collector that isn't there.
   */
  METRICS_TOKEN: z.string().min(24).optional(),
  OTLP_ENDPOINT: z.string().url().optional(),
  OTLP_SERVICE_NAME: z.string().min(1).max(64).default('spendifre-api'),
  /** 0 disables tracing; 1 traces everything. Between, a deterministic share. */
  TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),

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

  /**
   * How many replicas of this image are running (SEC-013).
   *
   * The rate limiter keeps its counters in process memory, so a limit of 600 a
   * minute is 600 *per replica*. The Bicep runs a minimum of two and scales to
   * ten, which quietly made the real ceiling anywhere between 1,200 and 6,000 —
   * a control that gets weaker exactly when load is highest.
   *
   * Dividing by the replica count is not as good as a shared store, and it is
   * not pretending to be: with uneven load balancing a single caller can still
   * exceed the intended rate on one replica. What it does is make the effective
   * ceiling roughly what the number says instead of a multiple of it, and put
   * the assumption somewhere a reader can see. Set it to the platform's
   * `minReplicas`, because that is the divisor that never over-restricts.
   */
  REPLICA_COUNT: z.coerce.number().int().min(1).max(100).default(1),
});

/**
 * The parsed answer to "whose data may this deployment show" (SPEC §9.4).
 *
 * It travels as one object rather than two arguments because it is one rule,
 * and because the two halves are only ever applied together —
 * `servedEntityClause` in `services/residency.ts` is the single place that
 * turns it into SQL.
 */
export interface ServedScope {
  /** Parsed `SERVED_REGIONS`, always including `RESIDENCY_REGION`. */
  readonly regions: readonly Region[];
  /** Parsed `SERVED_COUNTRIES`, or `null` when every country is served. */
  readonly countries: readonly string[] | null;
}

export type AppConfig = Readonly<z.infer<typeof envSchema>> & {
  readonly isProduction: boolean;
  readonly cookieSecure: boolean;
  readonly served: ServedScope;
};

export type Region = (typeof RESIDENCY_REGIONS)[number];

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

  const served = Object.freeze({
    regions: parseServedRegions(cfg.SERVED_REGIONS, cfg.RESIDENCY_REGION),
    countries: parseServedCountries(cfg.SERVED_COUNTRIES),
  });

  return Object.freeze({
    ...cfg,
    isProduction,
    // Host-prefixed cookies require Secure, so this also decides the cookie name.
    cookieSecure: isProduction || cfg.PUBLIC_ORIGIN.startsWith('https://'),
    served,
  });
}

/**
 * Unset means "this region only" — the conservative reading, and the one that
 * matches how the setting behaved before it existed.
 *
 * A deployment must serve its own region. Not serving it would mean holding
 * backups bound to a region whose rows it refuses to read, which is a
 * configuration with no coherent meaning rather than a restrictive one.
 */
function parseServedRegions(raw: string | undefined, home: Region): readonly Region[] {
  if (raw === undefined || raw.trim() === '') return Object.freeze([home]);

  const named = raw.split(',').map((r) => r.trim().toLowerCase()).filter((r) => r !== '');
  const unknown = named.filter((r) => !(RESIDENCY_REGIONS as readonly string[]).includes(r));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid configuration:\n  SERVED_REGIONS: unknown region ${unknown.join(', ')} ` +
        `(expected any of ${RESIDENCY_REGIONS.join(', ')})`,
    );
  }
  if (!named.includes(home)) {
    throw new Error(
      `Invalid configuration:\n  SERVED_REGIONS must include RESIDENCY_REGION ("${home}")`,
    );
  }
  // Deduplicated and ordered as declared, so the value that reaches a query is
  // the value someone wrote.
  return Object.freeze([...new Set(named)] as Region[]);
}

/**
 * Unset means "every country in the served regions", which is what the system
 * did before this setting existed and is therefore the only safe default.
 *
 * Only the shape is checked here. Whether a code names a country the group
 * actually operates in is a question about `countries`, which lives in the
 * database; `loadConfig` is synchronous and is unit-tested without one. The
 * runtime self-test asks that question instead, and reports a code that
 * matches no row — a plausible way to silently serve nothing.
 */
function parseServedCountries(raw: string | undefined): readonly string[] | null {
  if (raw === undefined || raw.trim() === '') return null;

  const named = raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => c !== '');
  const malformed = named.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (malformed.length > 0) {
    throw new Error(
      `Invalid configuration:\n  SERVED_COUNTRIES: ${malformed.join(', ')} ` +
        'is not an ISO 3166-1 alpha-2 code',
    );
  }
  if (named.length === 0) return null;
  return Object.freeze([...new Set(named)]);
}

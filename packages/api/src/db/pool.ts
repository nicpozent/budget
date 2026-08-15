/**
 * Database access (SEC-020).
 *
 * Everything goes through `sql`, a tagged template that builds a parameterised
 * statement. The interpolated values become $1, $2 … — they are never spliced
 * into the SQL text, so a template literal cannot accidentally become string
 * concatenation. The one place parameterisation does not help — dynamic ORDER
 * BY, column and table names — is served by `identifier()`, which only accepts
 * values from a caller-supplied allow-list.
 */

import pg from 'pg';
import type { AppConfig } from '../config.ts';

const { Pool } = pg;

// numeric(18,4) arrives as a string. Keep it that way: parsing it to a JS
// number here would silently reintroduce float money (NFR-002).
pg.types.setTypeParser(1700, (value) => value);
// int8 likewise, to avoid precision loss on the audit sequence.
pg.types.setTypeParser(20, (value) => value);

export interface SqlFragment {
  readonly text: string;
  readonly values: readonly unknown[];
}

const IS_FRAGMENT = Symbol('sql.fragment');

interface InternalFragment extends SqlFragment {
  readonly [IS_FRAGMENT]: true;
}

function isFragment(value: unknown): value is InternalFragment {
  return typeof value === 'object' && value !== null && IS_FRAGMENT in value;
}

/**
 * A value that is safe to place directly into SQL text because it came from an
 * allow-list rather than from request input. The only way to construct one is
 * `identifier()`, which validates against the caller's list.
 */
class SafeIdentifier {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

/**
 * SEC-020: dynamic ORDER BY / LIMIT / column names come from an allow-list.
 * The candidate is compared against the list by equality — not by pattern, not
 * by escaping — so anything not explicitly permitted is rejected.
 */
export function identifier(candidate: string, allowed: readonly string[]): SafeIdentifier {
  if (!allowed.includes(candidate)) {
    throw new Error(`identifier "${candidate}" is not in the allow-list`);
  }
  // Belt and braces: even an allow-listed value must look like an identifier,
  // so a mistake in an allow-list cannot become an injection.
  if (!/^[a-z_][a-z0-9_.]*(\s+(asc|desc))?$/i.test(candidate)) {
    throw new Error('allow-listed identifier has an unexpected shape');
  }
  return new SafeIdentifier(candidate);
}

/** Build a parameterised statement. Interpolated values are always bound. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  let text = '';
  const params: unknown[] = [];

  const append = (fragment: SqlFragment) => {
    // Renumber the nested fragment's placeholders into this statement's space.
    text += fragment.text.replace(/\$(\d+)/g, (_m, n: string) => {
      const idx = Number(n) - 1;
      params.push(fragment.values[idx]);
      return `$${params.length}`;
    });
  };

  strings.forEach((chunk, i) => {
    text += chunk;
    if (i >= values.length) return;
    const value = values[i];
    if (value instanceof SafeIdentifier) {
      text += value.value;
    } else if (isFragment(value)) {
      append(value);
    } else {
      params.push(value);
      text += `$${params.length}`;
    }
  });

  return Object.freeze({ [IS_FRAGMENT]: true, text, values: params }) as InternalFragment;
}

/** Join fragments with a separator, e.g. for a WHERE clause built from filters. */
export function join(fragments: readonly SqlFragment[], separator: string): SqlFragment {
  if (fragments.length === 0) return sql``;
  return fragments.reduce((acc, frag, i) =>
    i === 0 ? frag : sql`${acc}${raw(separator)}${frag}`,
  );
}

/**
 * Literal SQL text with no interpolation. Private to this module's own
 * helpers — it is not exported, so no call site outside here can reach it.
 */
function raw(text: string): SqlFragment {
  return Object.freeze({ [IS_FRAGMENT]: true, text, values: [] }) as InternalFragment;
}

export interface Db {
  query<T = Record<string, unknown>>(fragment: SqlFragment): Promise<T[]>;
  one<T = Record<string, unknown>>(fragment: SqlFragment): Promise<T | null>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PoolDb implements Db {
  readonly #runner: pg.Pool | pg.PoolClient;
  /** Non-null only for the pool-owning instance; a transaction's Db has none,
   *  which is how `transaction` detects nesting. */
  readonly #owner: pg.Pool | null;

  constructor(runner: pg.Pool | pg.PoolClient, owner: pg.Pool | null) {
    this.#runner = runner;
    this.#owner = owner;
  }

  async query<T = Record<string, unknown>>(fragment: SqlFragment): Promise<T[]> {
    const result = await this.#runner.query({
      text: fragment.text,
      values: fragment.values as unknown[],
    });
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(fragment: SqlFragment): Promise<T | null> {
    const rows = await this.query<T>(fragment);
    return rows[0] ?? null;
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.#owner) {
      // Already inside a transaction; reuse the client so nesting cannot
      // silently commit a partial unit of work.
      return fn(this);
    }
    const client = await this.#owner.connect();
    try {
      await client.query('begin');
      const result = await fn(new PoolDb(client, null));
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#owner) await this.#owner.end();
  }
}

export function createDb(config: Pick<AppConfig, 'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_STATEMENT_TIMEOUT_MS'>): Db {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    // Bound how long a single transaction may hold a connection open.
    idle_in_transaction_session_timeout: config.DB_STATEMENT_TIMEOUT_MS * 4,
    application_name: 'spendifre-api',
  });
  return new PoolDb(pool, pool);
}

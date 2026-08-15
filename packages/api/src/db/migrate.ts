/**
 * Migration runner. Runs as the migrator role, which is the only role holding
 * DDL (SEC-021) — the application's connection string must not be used here.
 *
 * Each file runs once, inside a transaction, and its checksum is recorded. A
 * file that changes after it has been applied is a hard failure: silently
 * re-running edited DDL is how environments drift apart.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

export async function migrate(connectionString: string, log = console.log): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename    text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied = new Map<string, string>();
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'select filename, checksum from schema_migrations',
    );
    for (const row of rows) applied.set(row.filename, row.checksum);

    for (const filename of files) {
      const contents = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const checksum = createHash('sha256').update(contents).digest('hex');
      const previous = applied.get(filename);

      if (previous === checksum) continue;
      if (previous && previous !== checksum) {
        throw new Error(
          `migration ${filename} has changed since it was applied — write a new migration instead`,
        );
      }

      log(`applying ${filename}`);
      await client.query('begin');
      try {
        await client.query(contents);
        await client.query(
          'insert into schema_migrations (filename, checksum) values ($1, $2)',
          [filename, checksum],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${filename} failed: ${(err as Error).message}`);
      }
    }
    log('migrations up to date');
  } finally {
    await client.end();
  }
}

const isEntrypoint = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isEntrypoint) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL or DATABASE_URL must be set');
    process.exit(1);
  }
  migrate(url).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

/** Process entrypoint. Keeps startup, shutdown and wiring in one visible place. */

import { loadConfig } from './config.ts';
import { createDb } from './db/pool.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const db = createDb(config);
const app = await buildApp({ db, config });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(
  { region: config.RESIDENCY_REGION, fiscalYear: config.FISCAL_YEAR },
  'spendifre api listening',
);

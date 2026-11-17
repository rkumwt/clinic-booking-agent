import { config } from 'dotenv';
import { resolve } from 'path';

/**
 * E2E tests run against their own Postgres database (`<name>_test`) and Redis
 * database 1, so they never touch dev data and the dev server's scheduled
 * jobs cannot interfere with them.
 */
export function applyTestEnv(): void {
  config({ path: resolve(__dirname, '../../../.env') });

  const db = new URL(process.env.DATABASE_URL ?? '');
  if (!db.pathname.endsWith('_test')) db.pathname = `${db.pathname}_test`;
  process.env.DATABASE_URL = db.toString();

  const redis = new URL(process.env.REDIS_URL ?? '');
  redis.pathname = '/1';
  process.env.REDIS_URL = redis.toString();

  process.env.NODE_ENV = 'test';
}

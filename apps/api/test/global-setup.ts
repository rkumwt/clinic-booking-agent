import { execSync } from 'child_process';
import { resolve } from 'path';
import { applyTestEnv } from './test-env';

// Creates the test database if needed and brings it up to date.
export default function globalSetup() {
  applyTestEnv();
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env: process.env,
    stdio: 'pipe',
  });
}

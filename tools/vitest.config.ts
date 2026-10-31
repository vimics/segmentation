import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Local tools that run against test-data/. Kept apart from `npm test`, so CI never looks for real cases. */
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: { include: ['tools/*.run.ts'], testTimeout: 3_600_000 },
});

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    passWithNoTests: true,
    globals: true,
    environment: 'node',
    // Existing route tests exercise their own boundary. Session-control tests
    // opt in with an explicit config so hundreds of unrelated fixtures do not
    // need to manufacture a browser cookie.
    env: { PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES: 'disabled' },
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts', '**/.smoke-test/**', '**/.databricks/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
    },
  },
});

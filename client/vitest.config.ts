import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the app config pulls in the PWA
// plugin and https certs, none of which belong in a Node test run.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
});

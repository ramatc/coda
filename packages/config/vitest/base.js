import { defineConfig } from "vitest/config";

/**
 * Shared Vitest preset for the Coda monorepo.
 *
 * Packages consume this by re-exporting it from their own `vitest.config.ts`,
 * which guarantees a single test-runner configuration surface across the repo.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    passWithNoTests: true,
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
  },
});

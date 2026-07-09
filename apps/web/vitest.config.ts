import react from "@vitejs/plugin-react";
import { mergeConfig } from "vitest/config";
import base from "@coda/config/vitest/base.js";

/**
 * Vitest config for the web app. Re-uses the shared `@coda/config` preset so
 * the whole monorepo keeps one test surface, and adds `@vitejs/plugin-react`
 * for the JSX transform (Vitest 4's default Oxc transformer does not enable
 * JSX on its own). Most tests (e.g. the Fase 0 smoke tests that render the
 * public page via `react-dom/server` and statically assert the Clerk
 * middleware matcher) only need the default `node` environment, so that
 * stays the shared default here. Component tests that need a real DOM (e.g.
 * `test/onboarding-wizard.test.tsx`) opt into `jsdom` per-file via a
 * `// @vitest-environment jsdom` docblock instead of changing this default.
 */
export default mergeConfig(base, {
  plugins: [react()],
});

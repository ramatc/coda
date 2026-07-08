import react from "@vitejs/plugin-react";
import { mergeConfig } from "vitest/config";
import base from "@coda/config/vitest/base.js";

/**
 * Vitest config for the web app. Re-uses the shared `@coda/config` preset so
 * the whole monorepo keeps one test surface, and adds `@vitejs/plugin-react`
 * for the JSX transform (Vitest 4's default Oxc transformer does not enable
 * JSX on its own). Fase 0 smoke tests render the public page via
 * `react-dom/server` and statically assert the Clerk middleware matcher, so the
 * default `node` environment is sufficient.
 */
export default mergeConfig(base, {
  plugins: [react()],
});

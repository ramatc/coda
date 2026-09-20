import react from "@vitejs/plugin-react";
import { mergeConfig } from "vitest/config";
import base from "@coda/config/vitest/base.js";

/**
 * Vitest config for `@coda/ui`. Mirrors `apps/web`'s: re-uses the shared
 * `@coda/config` preset, adds `@vitejs/plugin-react` for the JSX transform.
 */
export default mergeConfig(base, {
  plugins: [react()],
});

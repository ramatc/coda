import swc from "unplugin-swc";
import { mergeConfig } from "vitest/config";
import base from "@coda/config/vitest/base.js";

/**
 * Vitest config for the NestJS API.
 *
 * Re-uses the shared `@coda/config` preset (one test surface across the repo)
 * and layers in the SWC transform NestJS needs: legacy decorators plus
 * `emitDecoratorMetadata`, which esbuild (Vitest's default) does not produce.
 * A setup file loads `reflect-metadata` before any decorated class evaluates.
 */
export default mergeConfig(base, {
  // Vitest 4 transforms via Oxc by default, which does not emit decorator
  // metadata. Disable it so the SWC plugin below is the sole transformer.
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});

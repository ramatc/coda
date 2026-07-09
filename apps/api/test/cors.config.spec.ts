import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { buildCorsOptions } from "../src/cors.config.js";

/**
 * Exercises the ACTUAL CORS-configuration code path `main.ts`'s `bootstrap()`
 * calls (`app.enableCors(buildCorsOptions(config))`). Every e2e spec boots the
 * test app via `Test.createTestingModule({ imports: [AppModule] }).compile()`
 * + `createNestApplication()`, which never calls `bootstrap()` — so without
 * this test, a regression that removed or broke CORS would pass CI silently.
 */
function fakeConfig(appUrl: string | undefined): ConfigService {
  return {
    get: (key: string) => (key === "APP_URL" ? appUrl : undefined),
  } as unknown as ConfigService;
}

describe("buildCorsOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scopes CORS to APP_URL with the expected methods/headers", () => {
    const options = buildCorsOptions(fakeConfig("https://coda.test"));

    expect(options.origin).toBe("https://coda.test");
    expect(options.methods).toEqual(["GET", "POST", "PATCH", "DELETE"]);
    expect(options.allowedHeaders).toEqual(["Content-Type", "Authorization"]);
  });

  it("fails closed (origin: false) and logs a warning naming APP_URL when it is missing", () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const options = buildCorsOptions(fakeConfig(undefined));

    expect(options.origin).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("APP_URL"));
  });
});

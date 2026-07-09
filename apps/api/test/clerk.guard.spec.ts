import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ConfigService } from "@nestjs/config";
import { verifyToken } from "@clerk/backend";
import { ClerkGuard } from "../src/auth/clerk.guard.js";

// Mock the Clerk SDK at the module boundary so no network / real key is needed.
vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(),
}));

const mockedVerifyToken = vi.mocked(verifyToken);

/**
 * Exercises the missing-`APP_URL` warning path directly on `ClerkGuard`,
 * mirroring the pattern in `cors.config.spec.ts` for the equivalent CORS
 * warning. Asserts the warning fires ONCE at guard construction rather than
 * once per guarded request (Round 4 finding).
 */
describe("ClerkGuard authorizedParties warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockedVerifyToken.mockReset();
  });

  it("logs a warning naming APP_URL once when it is missing at construction time", () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const config = {
      get: (key: string) => (key === "APP_URL" ? undefined : "test-secret"),
    } as unknown as ConfigService;

    new ClerkGuard(new Reflector(), config);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("APP_URL"));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-log the warning on subsequent guarded requests (fires once at boot, not per-request)", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const config = {
      get: (key: string) => (key === "APP_URL" ? undefined : "test-secret"),
    } as unknown as ConfigService;

    const guard = new ClerkGuard(new Reflector(), config);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    mockedVerifyToken.mockResolvedValue({
      sub: "user_abc123",
      sid: "sess_xyz789",
    } as Awaited<ReturnType<typeof verifyToken>>);

    function dummyHandler() {
      /* no metadata attached — not a @Public() route */
    }
    class DummyClass {}

    const makeContext = () => ({
      getHandler: () => dummyHandler,
      getClass: () => DummyClass,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: "Bearer valid.jwt.token" },
        }),
      }),
    });

    await guard.canActivate(makeContext() as never);
    await guard.canActivate(makeContext() as never);
    await guard.canActivate(makeContext() as never);

    // Still just the one warning from construction — not one per request.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

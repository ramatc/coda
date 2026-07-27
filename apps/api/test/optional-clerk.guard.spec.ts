import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ConfigService } from "@nestjs/config";
import { verifyToken } from "@clerk/backend";
import { OptionalClerkGuard } from "../src/auth/optional-clerk.guard.js";
import {
  type AuthenticatedUser,
  IS_PUBLIC_KEY,
} from "../src/auth/auth.types.js";

// Mock the Clerk SDK at the module boundary so no network / real key is needed
// (same seam as `clerk.guard.spec.ts` and `auth-guard.e2e.spec.ts`).
vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(),
}));

const mockedVerifyToken = vi.mocked(verifyToken);

const VERIFIED_PAYLOAD = {
  sub: "user_abc123",
  sid: "sess_xyz789",
} as AuthenticatedUser;

function fakeConfig(): ConfigService {
  return {
    get: (key: string) =>
      key === "APP_URL" ? "https://app.test" : "test-secret",
  } as unknown as ConfigService;
}

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

/**
 * Builds an `ExecutionContext` plus the request object the guard mutates, so a
 * test can assert on `request.user` after `canActivate` resolves.
 *
 * `isPublic` attaches the same metadata the `@Public()` decorator sets, which
 * is what lets us prove the subclass deliberately IGNORES `IS_PUBLIC_KEY`.
 */
function contextFor(
  authorization: string | undefined,
  { isPublic = false }: { isPublic?: boolean } = {},
): { context: ExecutionContext; request: FakeRequest } {
  const request: FakeRequest = {
    headers: authorization === undefined ? {} : { authorization },
  };

  function handler() {
    /* route handler stand-in — metadata target */
  }
  class RouteClass {}

  if (isPublic) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  }

  const context = {
    getHandler: () => handler,
    getClass: () => RouteClass,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { context, request };
}

function buildGuard(): OptionalClerkGuard {
  return new OptionalClerkGuard(new Reflector(), fakeConfig());
}

describe("OptionalClerkGuard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockedVerifyToken.mockReset();
  });

  it("allows an anonymous request (no Authorization header) without attaching a user", async () => {
    const guard = buildGuard();
    const { context, request } = contextFor(undefined);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("verifies a present Bearer token and attaches the payload to request.user", async () => {
    mockedVerifyToken.mockResolvedValue(VERIFIED_PAYLOAD);
    const guard = buildGuard();
    const { context, request } = contextFor("Bearer valid.jwt.token");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(VERIFIED_PAYLOAD);
    expect(mockedVerifyToken).toHaveBeenCalledWith(
      "valid.jwt.token",
      expect.objectContaining({ secretKey: "test-secret" }),
    );
  });

  it("degrades an invalid or expired token to anonymous (200, never 401) and logs the failure", async () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    mockedVerifyToken.mockRejectedValue(new Error("token expired"));
    const guard = buildGuard();
    const { context, request } = contextFor("Bearer expired.jwt.token");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
    // A broken client stays visible in the logs instead of being silently
    // downgraded to "anonymous".
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("token expired"),
    );
  });

  it("degrades a malformed Authorization header to anonymous without calling verifyToken", async () => {
    const guard = buildGuard();
    const { context, request } = contextFor("NotBearer token");

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("still verifies the token on a @Public() route (ignores IS_PUBLIC_KEY, unlike ClerkGuard)", async () => {
    mockedVerifyToken.mockResolvedValue(VERIFIED_PAYLOAD);
    const guard = buildGuard();
    const { context, request } = contextFor("Bearer valid.jwt.token", {
      isPublic: true,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // The whole point of this guard: `ClerkGuard` would have short-circuited on
    // `IS_PUBLIC_KEY` and left `request.user` undefined for a signed-in caller.
    expect(mockedVerifyToken).toHaveBeenCalledTimes(1);
    expect(request.user).toEqual(VERIFIED_PAYLOAD);
  });
});

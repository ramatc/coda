import { describe, expect, it } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { CatalogAdminGuard } from "../src/catalog-import/catalog-admin.guard.js";

function fakeConfig(allowlist: string | undefined): ConfigService {
  return {
    get: (key: string) =>
      key === "CATALOG_ADMIN_USER_IDS" ? allowlist : undefined,
  } as unknown as ConfigService;
}

function contextForUser(sub: string | undefined): ExecutionContext {
  const request = sub === undefined ? {} : { user: { sub } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("CatalogAdminGuard", () => {
  it("allows a Clerk user id present in the allowlist", () => {
    const guard = new CatalogAdminGuard(
      fakeConfig("user_admin_1, user_admin_2"),
    );
    expect(guard.canActivate(contextForUser("user_admin_2"))).toBe(true);
  });

  it("denies a Clerk user id that is not in the allowlist", () => {
    const guard = new CatalogAdminGuard(fakeConfig("user_admin_1"));
    expect(() => guard.canActivate(contextForUser("user_other"))).toThrow(
      ForbiddenException,
    );
  });

  it("fails CLOSED when the allowlist is unset (denies even a valid session)", () => {
    const guard = new CatalogAdminGuard(fakeConfig(undefined));
    expect(() => guard.canActivate(contextForUser("anyone"))).toThrow(
      ForbiddenException,
    );
  });

  it("fails CLOSED when the allowlist is empty/whitespace", () => {
    const guard = new CatalogAdminGuard(fakeConfig("  ,  "));
    expect(() => guard.canActivate(contextForUser("anyone"))).toThrow(
      ForbiddenException,
    );
  });

  it("denies a request with no authenticated user", () => {
    const guard = new CatalogAdminGuard(fakeConfig("user_admin_1"));
    expect(() => guard.canActivate(contextForUser(undefined))).toThrow(
      ForbiddenException,
    );
  });
});

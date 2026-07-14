import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { verifyToken } from "@clerk/backend";
import { AppModule } from "../src/app.module.js";

// Mock the Clerk SDK at the module boundary so no network / real key is needed
// (matches auth-guard.e2e / search.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
const mockedVerifyToken = vi.mocked(verifyToken);

/**
 * HTTP-layer proof that the social routes are actually wired into the router
 * under the paths the controller declares — `social.controller.spec.ts` only
 * calls the controller's methods directly and never exercises Nest's routing,
 * so it cannot catch a `@Post`/`@Get` path typo. Asserting 401 (not 404) for
 * an unauthenticated request proves the route resolved and the global
 * `ClerkGuard` ran, without needing a real Prisma-backed user.
 */
describe("Social API (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockedVerifyToken.mockReset();
  });

  it("routes POST /users/:username/follow and requires authentication (401, not 404)", async () => {
    const res = await request(app.getHttpServer()).post(
      "/users/someuser/follow",
    );

    expect(res.status).toBe(401);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("routes DELETE /users/:username/follow and requires authentication (401, not 404)", async () => {
    const res = await request(app.getHttpServer()).delete(
      "/users/someuser/follow",
    );

    expect(res.status).toBe(401);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("routes GET /users/:username/social and requires authentication (401, not 404)", async () => {
    const res = await request(app.getHttpServer()).get(
      "/users/someuser/social",
    );

    expect(res.status).toBe(401);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("routes GET /feed and requires authentication (401, not 404)", async () => {
    const res = await request(app.getHttpServer()).get("/feed");

    expect(res.status).toBe(401);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });
});

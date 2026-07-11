import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { verifyToken } from "@clerk/backend";
import { AppModule } from "../src/app.module.js";
import { MeiliService } from "../src/search/meili.service.js";

// Mock the Clerk SDK at the module boundary so the global guard admits requests
// with a stub token — no network / real key needed (matches auth-guard.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
const mockedVerifyToken = vi.mocked(verifyToken);

/**
 * HTTP-layer proof for the search query API: an empty/whitespace query is a 400
 * that never reaches Meilisearch (task 7.3), and a real query is served through
 * the (overridden) Meilisearch client. `MeiliService` is overridden with a fake
 * so no live Meili is required (sandbox convention).
 */
describe("Search API (e2e)", () => {
  let app: INestApplication;
  const fakeMeili = {
    searchAlbums: vi
      .fn()
      .mockResolvedValue({ hits: [{ id: "a1", title: "OK Computer" }], estimatedTotalHits: 1 }),
    searchArtists: vi.fn().mockResolvedValue({ hits: [], estimatedTotalHits: 0 }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MeiliService)
      .useValue(fakeMeili)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockedVerifyToken.mockReset();
    mockedVerifyToken.mockResolvedValue({
      sub: "user_abc123",
      sid: "sess_1",
    } as Awaited<ReturnType<typeof verifyToken>>);
    fakeMeili.searchAlbums.mockClear();
    fakeMeili.searchArtists.mockClear();
  });

  const TOKEN = "Bearer valid.jwt.token";

  it("returns 400 for a missing query and never calls Meilisearch", async () => {
    const res = await request(app.getHttpServer())
      .get("/search")
      .set("Authorization", TOKEN);

    expect(res.status).toBe(400);
    expect(fakeMeili.searchAlbums).not.toHaveBeenCalled();
  });

  it("returns 400 for a whitespace-only query and never calls Meilisearch", async () => {
    const res = await request(app.getHttpServer())
      .get("/search")
      .query({ q: "   " })
      .set("Authorization", TOKEN);

    expect(res.status).toBe(400);
    expect(fakeMeili.searchAlbums).not.toHaveBeenCalled();
  });

  it("returns ranked results for a valid query", async () => {
    const res = await request(app.getHttpServer())
      .get("/search")
      .query({ q: "radiohead" })
      .set("Authorization", TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.query).toBe("radiohead");
    expect(res.body.albums).toEqual([{ id: "a1", title: "OK Computer" }]);
    expect(fakeMeili.searchAlbums).toHaveBeenCalledTimes(1);
  });

  it("requires authentication (401 without a token)", async () => {
    const res = await request(app.getHttpServer())
      .get("/search")
      .query({ q: "radiohead" });

    expect(res.status).toBe(401);
  });
});

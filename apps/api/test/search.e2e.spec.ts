import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { verifyToken } from "@clerk/backend";
import { AppModule } from "../src/app.module.js";
import { MeiliService } from "../src/search/meili.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

// Mock the Clerk SDK at the module boundary so the global guard admits requests
// with a stub token — no network / real key needed (matches auth-guard.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
const mockedVerifyToken = vi.mocked(verifyToken);

/** The two albums `GET /search/popular` reads, highest popularity first. */
const POPULAR_ROWS = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "OK Computer",
    coverUrl: null,
    primaryArtist: { name: "Radiohead" },
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "In Rainbows",
    coverUrl: "https://cdn.example/in-rainbows.jpg",
    primaryArtist: { name: "Radiohead" },
  },
];

/**
 * HTTP-layer proof for the search query API: an empty/whitespace query is a 400
 * that never reaches Meilisearch (task 7.3), and a real query is served through
 * the (overridden) Meilisearch client. `MeiliService` is overridden with a fake
 * so no live Meili is required (sandbox convention); `PrismaService` is stubbed
 * the same way for `GET /search/popular`, which reads Postgres directly.
 */
describe("Search API (e2e)", () => {
  let app: INestApplication;
  const fakeMeili = {
    searchAlbums: vi
      .fn()
      .mockResolvedValue({ hits: [{ id: "a1", title: "OK Computer" }], estimatedTotalHits: 1 }),
    searchArtists: vi.fn().mockResolvedValue({ hits: [], estimatedTotalHits: 0 }),
  };

  const albumFindMany = vi
    .fn()
    .mockImplementation(async (args: { take: number }) =>
      POPULAR_ROWS.slice(0, args.take),
    );
  const fakePrisma = {
    client: { album: { findMany: albumFindMany } },
  } as unknown as PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MeiliService)
      .useValue(fakeMeili)
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
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
    albumFindMany.mockClear();
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

  // The public landing page server-renders this route with no session at all, so
  // the global fail-closed `ClerkGuard` must stand down for THIS handler only.
  it("serves GET /search/popular without an Authorization header (200, never 401)", async () => {
    const res = await request(app.getHttpServer()).get("/search/popular");

    expect(res.status).toBe(200);
    // The PopularAlbum[] shape is unchanged by the guard flip.
    expect(res.body).toEqual([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "OK Computer",
        coverUrl: null,
        primaryArtistName: "Radiohead",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title: "In Rainbows",
        coverUrl: "https://cdn.example/in-rainbows.jpg",
        primaryArtistName: "Radiohead",
      },
    ]);
    expect(mockedVerifyToken).not.toHaveBeenCalled();
  });

  it("honours ?limit= on the anonymous popular route", async () => {
    const res = await request(app.getHttpServer())
      .get("/search/popular")
      .query({ limit: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "OK Computer",
        coverUrl: null,
        primaryArtistName: "Radiohead",
      },
    ]);
    expect(albumFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it("still serves GET /search/popular to a signed-in caller (200)", async () => {
    const res = await request(app.getHttpServer())
      .get("/search/popular")
      .set("Authorization", TOKEN);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

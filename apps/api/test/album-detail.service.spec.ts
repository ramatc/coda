import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AlbumDetailService } from "../src/tracking/album-detail.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";
const ARTIST_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ALBUM_ID = "44444444-4444-4444-8444-444444444444";
const CLERK_ID = "clerk_1";
const USER_ID = "11111111-1111-4111-8111-111111111111";

interface AlbumRow {
  id: string;
  title: string;
  coverUrl: string | null;
  releaseDate: Date | null;
  trackCount: number | null;
  primaryArtist: { id: string; name: string };
  genres: { genre: { id: string; slug: string; name: string } }[];
  tracks: {
    id: string;
    position: number;
    title: string;
    durationMs: number | null;
  }[];
}
interface RatingRow {
  userId: string;
  albumId: string;
  score: number;
}
interface ReviewRow {
  userId: string;
  albumId: string;
  body: string;
}
interface ListenRow {
  id: string;
  userId: string;
  albumId: string;
  listenedAt: Date;
}

/**
 * In-memory Prisma stand-in honouring the exact read query shapes
 * {@link AlbumDetailService} issues (album findUnique with nested
 * primaryArtist/genres/tracks, rating.aggregate, user/listen/rating/review
 * lookups). Proves the read path deterministically without a live Postgres
 * (PR1-8 no-docker sandbox convention).
 */
function createFakePrisma() {
  const users = new Map<string, string>();
  const albums = new Map<string, AlbumRow>();
  const ratings: RatingRow[] = [];
  const reviews: ReviewRow[] = [];
  const listens: ListenRow[] = [];

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = users.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    album: {
      async findUnique(args: {
        where: { id: string };
      }): Promise<AlbumRow | null> {
        return albums.get(args.where.id) ?? null;
      },
    },
    rating: {
      async aggregate(args: {
        where: { albumId: string };
      }): Promise<{ _avg: { score: number | null }; _count: { _all: number } }> {
        const rows = ratings.filter((r) => r.albumId === args.where.albumId);
        const count = rows.length;
        const avg =
          count === 0
            ? null
            : rows.reduce((sum, r) => sum + r.score, 0) / count;
        return { _avg: { score: avg }, _count: { _all: count } };
      },
      async findUnique(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
      }): Promise<{ score: number } | null> {
        const { userId, albumId } = args.where.userId_albumId;
        const row = ratings.find(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        return row ? { score: row.score } : null;
      },
    },
    review: {
      async findUnique(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
      }): Promise<{ body: string } | null> {
        const { userId, albumId } = args.where.userId_albumId;
        const row = reviews.find(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        return row ? { body: row.body } : null;
      },
    },
    listen: {
      async findFirst(args: {
        where: { userId: string; albumId: string };
      }): Promise<{ id: string } | null> {
        const rows = listens
          .filter(
            (r) =>
              r.userId === args.where.userId &&
              r.albumId === args.where.albumId,
          )
          .sort((a, b) => b.listenedAt.getTime() - a.listenedAt.getTime());
        return rows[0] ? { id: rows[0].id } : null;
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    users,
    albums,
    ratings,
    reviews,
    listens,
  };
}

function seedAlbum(
  fake: ReturnType<typeof createFakePrisma>,
  overrides: Partial<AlbumRow> = {},
): void {
  fake.albums.set(ALBUM_ID, {
    id: ALBUM_ID,
    title: "OK Computer",
    coverUrl: "https://cdn.coda.test/ok.jpg",
    releaseDate: new Date("1997-06-16T00:00:00.000Z"),
    trackCount: 12,
    primaryArtist: { id: ARTIST_ID, name: "Radiohead" },
    genres: [
      { genre: { id: "g1", slug: "alt-rock", name: "Alternative Rock" } },
    ],
    tracks: [
      { id: "t2", position: 2, title: "Paranoid Android", durationMs: 383000 },
      { id: "t1", position: 1, title: "Airbag", durationMs: 284000 },
    ],
    ...overrides,
  });
}

describe("AlbumDetailService", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: AlbumDetailService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new AlbumDetailService(fake.prisma);
  });

  it("returns album metadata, tracklist and release year", async () => {
    seedAlbum(fake);
    fake.users.set(CLERK_ID, USER_ID);

    const detail = await service.getAlbumDetail(CLERK_ID, ALBUM_ID);

    expect(detail.title).toBe("OK Computer");
    expect(detail.primaryArtist).toEqual({ id: ARTIST_ID, name: "Radiohead" });
    expect(detail.releaseDate).toBe("1997-06-16");
    expect(detail.releaseYear).toBe(1997);
    expect(detail.genres).toEqual([
      { id: "g1", slug: "alt-rock", name: "Alternative Rock" },
    ]);
    // Tracklist is returned in the order Prisma yields it (ordered by position).
    expect(detail.tracks.map((t) => t.title)).toEqual([
      "Paranoid Android",
      "Airbag",
    ]);
  });

  it("derives the aggregate rating from every user's ratings", async () => {
    seedAlbum(fake);
    fake.users.set(CLERK_ID, USER_ID);
    fake.ratings.push(
      { userId: USER_ID, albumId: ALBUM_ID, score: 8 },
      { userId: "other-user", albumId: ALBUM_ID, score: 10 },
    );

    const detail = await service.getAlbumDetail(CLERK_ID, ALBUM_ID);

    expect(detail.aggregateRating).toEqual({ average: 9, count: 2 });
  });

  it("renders the viewer's existing rating and review when they have tracked the album", async () => {
    seedAlbum(fake);
    fake.users.set(CLERK_ID, USER_ID);
    fake.listens.push({
      id: "listen-1",
      userId: USER_ID,
      albumId: ALBUM_ID,
      listenedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    fake.ratings.push({ userId: USER_ID, albumId: ALBUM_ID, score: 8 });
    fake.reviews.push({
      userId: USER_ID,
      albumId: ALBUM_ID,
      body: "A landmark record.",
    });

    const detail = await service.getAlbumDetail(CLERK_ID, ALBUM_ID);

    expect(detail.viewer).toEqual({
      listened: true,
      listenId: "listen-1",
      score: 8,
      review: "A landmark record.",
    });
  });

  it("returns an empty viewer state when the viewer has not tracked the album", async () => {
    seedAlbum(fake);
    fake.users.set(CLERK_ID, USER_ID);

    const detail = await service.getAlbumDetail(CLERK_ID, ALBUM_ID);

    expect(detail.viewer).toEqual({
      listened: false,
      listenId: null,
      score: null,
      review: null,
    });
    expect(detail.aggregateRating).toEqual({ average: null, count: 0 });
  });

  it("degrades to an empty viewer state (not 404) when the local user does not exist yet", async () => {
    seedAlbum(fake);
    // No user row for CLERK_ID — the Clerk webhook sync has not landed.

    const detail = await service.getAlbumDetail(CLERK_ID, ALBUM_ID);

    expect(detail.title).toBe("OK Computer");
    expect(detail.viewer.listened).toBe(false);
    expect(detail.viewer.score).toBeNull();
  });

  it("scopes the viewer state to the resolved user, never leaking another user's tracking data", async () => {
    seedAlbum(fake);
    const OTHER_CLERK_ID = "clerk_2";
    const OTHER_USER_ID = "55555555-5555-4555-8555-555555555555";
    fake.users.set(CLERK_ID, USER_ID);
    fake.users.set(OTHER_CLERK_ID, OTHER_USER_ID);

    // User A's own tracking state for the album.
    fake.listens.push({
      id: "listen-a",
      userId: USER_ID,
      albumId: ALBUM_ID,
      listenedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    fake.ratings.push({ userId: USER_ID, albumId: ALBUM_ID, score: 6 });
    fake.reviews.push({
      userId: USER_ID,
      albumId: ALBUM_ID,
      body: "User A's take.",
    });

    // User B's own (different) tracking state for the SAME album.
    fake.listens.push({
      id: "listen-b",
      userId: OTHER_USER_ID,
      albumId: ALBUM_ID,
      listenedAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    fake.ratings.push({ userId: OTHER_USER_ID, albumId: ALBUM_ID, score: 10 });
    fake.reviews.push({
      userId: OTHER_USER_ID,
      albumId: ALBUM_ID,
      body: "User B's take.",
    });

    const detail = await service.getAlbumDetail(CLERK_ID, ALBUM_ID);

    // Only user A's own tracking data is returned — none of user B's.
    expect(detail.viewer).toEqual({
      listened: true,
      listenId: "listen-a",
      score: 6,
      review: "User A's take.",
    });
    // The aggregate still reflects both users' ratings.
    expect(detail.aggregateRating).toEqual({ average: 8, count: 2 });
  });

  it("throws 404 for an unknown album", async () => {
    fake.users.set(CLERK_ID, USER_ID);

    await expect(
      service.getAlbumDetail(CLERK_ID, OTHER_ALBUM_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a malformed album id with a 400 before any query", async () => {
    await expect(
      service.getAlbumDetail(CLERK_ID, "not-a-uuid"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

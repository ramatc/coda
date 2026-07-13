import { beforeEach, describe, expect, it } from "vitest";
import { RecommendationStatus } from "@coda/db";
import {
  RecoGenerationService,
  scoreCandidate,
  type TasteProfile,
} from "../src/recommendations/reco-generation.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const GENRE_ROCK = "aaaaaaaa-0000-4000-8000-000000000001";
const GENRE_JAZZ = "aaaaaaaa-0000-4000-8000-000000000002";
const GENRE_POP = "aaaaaaaa-0000-4000-8000-000000000003";

const FAV_ARTIST = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_ARTIST = "bbbbbbbb-0000-4000-8000-000000000002";

const ALBUM_MATCH = "cccccccc-0000-4000-8000-000000000001"; // rock + fav artist
const ALBUM_GENRE_ONLY = "cccccccc-0000-4000-8000-000000000002"; // rock, most popular
const ALBUM_OTHER_GENRE = "cccccccc-0000-4000-8000-000000000003"; // pop only (off-taste)
const ALBUM_LISTENED = "cccccccc-0000-4000-8000-000000000004"; // rock, already listened
const ALBUM_DISMISSED = "cccccccc-0000-4000-8000-000000000005"; // rock, dismissed
const ALBUM_STALE = "cccccccc-0000-4000-8000-000000000006"; // pre-existing ACTIVE, off-taste

interface AlbumFixture {
  id: string;
  popularityScore: number;
  primaryArtistId: string;
  genres: { genreId: string; weight: number }[];
}

interface RecoRow {
  id: string;
  userId: string;
  albumId: string;
  score: number;
  reason: unknown;
  status: RecommendationStatus;
  generatedAt: Date;
}

/**
 * In-memory Prisma stand-in honouring exactly the reads/writes
 * {@link RecoGenerationService} issues: the taste + exclusion `findMany`s, the
 * genre-prefiltered candidate `album.findMany`, `genre.findMany`, and the
 * prune+upsert `$transaction`. Proves generation deterministically without a
 * live Postgres (PR1-10 no-docker sandbox convention).
 */
function createFakePrisma() {
  const genrePrefs: { genreId: string; weight: number }[] = [];
  const artistFavorites: { artistId: string }[] = [];
  const albumFavorites: { albumId: string }[] = [];
  const ratings: { albumId: string; score: number }[] = [];
  const listens: { albumId: string }[] = [];
  const albums: AlbumFixture[] = [];
  const genres = new Map<string, string>();
  const recos = new Map<string, RecoRow>();
  let seq = 0;

  const client = {
    userGenrePreference: {
      findMany: async () => genrePrefs.map((p) => ({ ...p })),
    },
    userArtistFavorite: {
      findMany: async () => artistFavorites.map((a) => ({ ...a })),
    },
    userAlbumFavorite: {
      findMany: async () => albumFavorites.map((a) => ({ ...a })),
    },
    rating: {
      findMany: async () => ratings.map((r) => ({ ...r })),
    },
    listen: {
      findMany: async () => listens.map((l) => ({ ...l })),
    },
    genre: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in
          .filter((id) => genres.has(id))
          .map((id) => ({ id, name: genres.get(id) as string })),
    },
    recommendation: {
      findMany: async (args: {
        where: { userId: string; status?: RecommendationStatus };
      }) =>
        [...recos.values()]
          .filter(
            (r) =>
              r.userId === args.where.userId &&
              (args.where.status === undefined ||
                r.status === args.where.status),
          )
          .map((r) => ({ albumId: r.albumId })),
      deleteMany: async (args: {
        where: {
          userId: string;
          status?: RecommendationStatus;
          albumId?: { notIn: string[] };
        };
      }) => {
        let count = 0;
        for (const [key, row] of [...recos]) {
          if (row.userId !== args.where.userId) continue;
          if (args.where.status && row.status !== args.where.status) continue;
          if (
            args.where.albumId?.notIn &&
            args.where.albumId.notIn.includes(row.albumId)
          ) {
            continue;
          }
          recos.delete(key);
          count += 1;
        }
        return { count };
      },
    },
    // Fake of the bulk-upsert raw SQL `persist()`/`upsertBatch()` issue
    // (judgment-day fix, round 2): `$executeRaw` is invoked as a tagged
    // template, so this receives the strings array followed by the
    // interpolated values IN ORDER — `userId`, then the parallel
    // `albumIds`/`scores`/`reasons` arrays — and reproduces the same
    // insert-or-update-by-(userId,albumId) semantics the real `INSERT ...
    // ON CONFLICT` statement performs, without needing a live Postgres.
    $executeRaw: async (
      _strings: TemplateStringsArray,
      userId: string,
      albumIds: string[],
      scores: number[],
      reasons: string[],
    ) => {
      albumIds.forEach((albumId, index) => {
        const key = `${userId}:${albumId}`;
        const reason = JSON.parse(reasons[index]) as unknown;
        const existing = recos.get(key);
        if (existing) {
          existing.score = scores[index];
          existing.reason = reason;
          existing.status = RecommendationStatus.ACTIVE;
          existing.generatedAt = new Date();
          return;
        }
        seq += 1;
        recos.set(key, {
          id: `rec-${seq}`,
          userId,
          albumId,
          score: scores[index],
          reason,
          status: RecommendationStatus.ACTIVE,
          generatedAt: new Date(),
        });
      });
      return albumIds.length;
    },
    album: {
      findMany: async (args: {
        where?: {
          id?: { in?: string[]; notIn?: string[] };
          genres?: { some: { genreId: { in: string[] } } };
        };
        orderBy?: { popularityScore?: "desc" };
        take?: number;
      }) => {
        const where = args.where ?? {};
        let rows = [...albums];
        if (where.id?.in) {
          rows = rows.filter((a) => where.id?.in?.includes(a.id));
        }
        if (where.genres?.some?.genreId?.in) {
          const set = where.genres.some.genreId.in;
          rows = rows.filter((a) =>
            a.genres.some((g) => set.includes(g.genreId)),
          );
        }
        if (where.id?.notIn) {
          rows = rows.filter((a) => !where.id?.notIn?.includes(a.id));
        }
        if (args.orderBy?.popularityScore === "desc") {
          rows.sort((a, b) => b.popularityScore - a.popularityScore);
        }
        if (args.take) {
          rows = rows.slice(0, args.take);
        }
        return rows.map((a) => ({
          id: a.id,
          popularityScore: a.popularityScore,
          primaryArtistId: a.primaryArtistId,
          genres: a.genres.map((g) => ({ ...g })),
        }));
      },
    },
    $transaction: async <T>(fn: (tx: typeof client) => Promise<T>): Promise<T> =>
      fn(client),
  };

  return {
    prisma: { client } as unknown as PrismaService,
    genrePrefs,
    artistFavorites,
    albumFavorites,
    ratings,
    listens,
    albums,
    genres,
    recos,
  };
}

/** Seeds a standard rock/jazz taste + a rock catalog, minus off-taste noise. */
function seedCatalog(fake: ReturnType<typeof createFakePrisma>): void {
  fake.genres.set(GENRE_ROCK, "Rock");
  fake.genres.set(GENRE_JAZZ, "Jazz");
  fake.genres.set(GENRE_POP, "Pop");
  fake.genrePrefs.push(
    { genreId: GENRE_ROCK, weight: 1 },
    { genreId: GENRE_JAZZ, weight: 1 },
  );
  fake.artistFavorites.push({ artistId: FAV_ARTIST });

  fake.albums.push(
    {
      id: ALBUM_MATCH,
      popularityScore: 50,
      primaryArtistId: FAV_ARTIST,
      genres: [{ genreId: GENRE_ROCK, weight: 1 }],
    },
    {
      id: ALBUM_GENRE_ONLY,
      popularityScore: 100,
      primaryArtistId: OTHER_ARTIST,
      genres: [{ genreId: GENRE_ROCK, weight: 1 }],
    },
    {
      id: ALBUM_OTHER_GENRE,
      popularityScore: 80,
      primaryArtistId: OTHER_ARTIST,
      genres: [{ genreId: GENRE_POP, weight: 1 }],
    },
    {
      id: ALBUM_LISTENED,
      popularityScore: 90,
      primaryArtistId: OTHER_ARTIST,
      genres: [{ genreId: GENRE_ROCK, weight: 1 }],
    },
    {
      id: ALBUM_DISMISSED,
      popularityScore: 95,
      primaryArtistId: OTHER_ARTIST,
      genres: [{ genreId: GENRE_ROCK, weight: 1 }],
    },
  );
}

/** The album ids of the user's ACTIVE recommendations after a run. */
function activeAlbumIds(fake: ReturnType<typeof createFakePrisma>): string[] {
  return [...fake.recos.values()]
    .filter((r) => r.status === RecommendationStatus.ACTIVE)
    .map((r) => r.albumId);
}

describe("RecoGenerationService", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: RecoGenerationService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new RecoGenerationService(fake.prisma);
  });

  it("gives a cold-start user (preferences, no activity) recommendations from genre + popularity", async () => {
    seedCatalog(fake);

    const result = await service.generateForUser(USER_ID);

    expect(result.generated).toBeGreaterThan(0);
    const ids = activeAlbumIds(fake);
    // Both rock albums are recommended; the off-taste pop album is not.
    expect(ids).toContain(ALBUM_MATCH);
    expect(ids).toContain(ALBUM_GENRE_ONLY);
    expect(ids).not.toContain(ALBUM_OTHER_GENRE);
  });

  it("ranks a genre+artist match above a merely popular genre match", async () => {
    seedCatalog(fake);

    await service.generateForUser(USER_ID);

    const match = [...fake.recos.values()].find(
      (r) => r.albumId === ALBUM_MATCH,
    );
    const genreOnly = [...fake.recos.values()].find(
      (r) => r.albumId === ALBUM_GENRE_ONLY,
    );
    expect(match).toBeDefined();
    expect(genreOnly).toBeDefined();
    // Artist affinity (0.35) outweighs the popularity edge (0.15) the other
    // album has, so the fav-artist album scores higher despite lower popularity.
    expect((match as RecoRow).score).toBeGreaterThan(
      (genreOnly as RecoRow).score,
    );
    // The reason carries the matched genre name + the artist-match flag.
    expect((match as RecoRow).reason).toMatchObject({
      topGenre: "Rock",
      matchedArtist: true,
    });
  });

  it("excludes albums the user already listened to or rated", async () => {
    seedCatalog(fake);
    fake.listens.push({ albumId: ALBUM_LISTENED });
    fake.ratings.push({ albumId: ALBUM_GENRE_ONLY, score: 4 });

    await service.generateForUser(USER_ID);

    const ids = activeAlbumIds(fake);
    expect(ids).not.toContain(ALBUM_LISTENED);
    expect(ids).not.toContain(ALBUM_GENRE_ONLY);
    expect(ids).toContain(ALBUM_MATCH);
  });

  it("never re-surfaces a dismissed album, and leaves the dismissal intact", async () => {
    seedCatalog(fake);
    fake.recos.set(`${USER_ID}:${ALBUM_DISMISSED}`, {
      id: "rec-dismissed",
      userId: USER_ID,
      albumId: ALBUM_DISMISSED,
      score: 0.9,
      reason: null,
      status: RecommendationStatus.DISMISSED,
      generatedAt: new Date(),
    });

    await service.generateForUser(USER_ID);

    expect(activeAlbumIds(fake)).not.toContain(ALBUM_DISMISSED);
    // The DISMISSED row is untouched by the prune (only ACTIVE rows are pruned).
    expect(fake.recos.get(`${USER_ID}:${ALBUM_DISMISSED}`)?.status).toBe(
      RecommendationStatus.DISMISSED,
    );
  });

  it("prunes a stale ACTIVE recommendation that fell out of the top set", async () => {
    seedCatalog(fake);
    fake.albums.push({
      id: ALBUM_STALE,
      popularityScore: 10,
      primaryArtistId: OTHER_ARTIST,
      genres: [{ genreId: GENRE_POP, weight: 1 }], // off-taste → not a candidate
    });
    fake.recos.set(`${USER_ID}:${ALBUM_STALE}`, {
      id: "rec-stale",
      userId: USER_ID,
      albumId: ALBUM_STALE,
      score: 0.1,
      reason: null,
      status: RecommendationStatus.ACTIVE,
      generatedAt: new Date(),
    });

    const result = await service.generateForUser(USER_ID);

    expect(result.pruned).toBeGreaterThan(0);
    expect(activeAlbumIds(fake)).not.toContain(ALBUM_STALE);
  });

  it("generates nothing for a user with no genre preferences (not onboarded)", async () => {
    // No genre prefs, no favorites — no taste signal to score against.
    fake.albums.push({
      id: ALBUM_GENRE_ONLY,
      popularityScore: 100,
      primaryArtistId: OTHER_ARTIST,
      genres: [{ genreId: GENRE_ROCK, weight: 1 }],
    });

    const result = await service.generateForUser(USER_ID);

    expect(result.generated).toBe(0);
    expect(activeAlbumIds(fake)).toHaveLength(0);
  });
});

describe("scoreCandidate (pure heuristic)", () => {
  const taste: TasteProfile = {
    genreWeight: new Map([
      [GENRE_ROCK, 1],
      [GENRE_JAZZ, 1],
    ]),
    totalGenreWeight: 2,
    artistAffinity: new Set([FAV_ARTIST]),
    topGenreIds: [GENRE_ROCK, GENRE_JAZZ],
  };
  const genreNames = new Map([[GENRE_ROCK, "Rock"]]);

  it("weights genre overlap, artist overlap, and popularity per the design formula", () => {
    const scored = scoreCandidate(
      {
        id: ALBUM_MATCH,
        popularityScore: 50,
        primaryArtistId: FAV_ARTIST,
        genres: [{ genreId: GENRE_ROCK, weight: 1 }],
      },
      taste,
      100,
      genreNames,
    );

    // genreOverlap = (1*1)/2 = 0.5 → 0.5*0.5 = 0.25; artistOverlap = 1 → 0.35;
    // popNorm = log1p(50)/log1p(100) → 0.15*~0.852 ≈ 0.128. Total ≈ 0.728.
    expect(scored.score).toBeCloseTo(0.25 + 0.35 + 0.15 * (Math.log1p(50) / Math.log1p(100)), 5);
    expect(scored.reason).toEqual({ topGenre: "Rock", matchedArtist: true });
  });

  it("scores an off-taste album (no shared genre, no artist) at zero", () => {
    const scored = scoreCandidate(
      {
        id: ALBUM_OTHER_GENRE,
        popularityScore: 0,
        primaryArtistId: OTHER_ARTIST,
        genres: [{ genreId: GENRE_POP, weight: 1 }],
      },
      taste,
      0,
      genreNames,
    );

    expect(scored.score).toBe(0);
    expect(scored.reason).toEqual({ topGenre: null, matchedArtist: false });
  });
});

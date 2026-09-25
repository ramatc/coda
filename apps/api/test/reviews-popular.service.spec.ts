import { describe, expect, it } from "vitest";
import { ReviewsService } from "../src/reviews/reviews.service.js";
import type { NotificationsService } from "../src/notifications/notifications.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import {
  DEFAULT_POPULAR_REVIEW_LIMIT,
  MAX_POPULAR_REVIEW_LIMIT,
  POPULAR_REVIEW_MIN_SCORE,
} from "../src/reviews/reviews.constants.js";

/** A stored review row, before the service projects it to `PopularReview`. */
interface SeedReview {
  id: string;
  body: string;
  isSpoiler: boolean;
  createdAt: Date;
  score: number;
  albumTitle: string;
  artistName: string;
  coverUrl: string | null;
  profile: {
    username: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  likes: number;
  comments: number;
}

function seed(overrides: Partial<SeedReview> = {}): SeedReview {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    body: "A masterpiece, front to back.",
    isSpoiler: false,
    createdAt: new Date("2026-07-25T10:00:00.000Z"),
    score: 9,
    albumTitle: "OK Computer",
    artistName: "Radiohead",
    coverUrl: "https://cdn.example/ok-computer.jpg",
    profile: { username: "author", displayName: "The Author", avatarUrl: null },
    likes: 4,
    comments: 2,
    ...overrides,
  };
}

/** The `findMany` args the service is expected to build. */
interface FindManyArgs {
  where: { rating: { score: { gte: number } } };
  orderBy: { createdAt?: "desc"; id?: "desc" }[];
  take: number;
}

/**
 * A Prisma double that really EXECUTES the query the service builds: it applies
 * `where.rating.score.gte`, then `orderBy`, then `take` against the seeded rows.
 *
 * Asserting the args object alone would prove only that the service typed a
 * literal — a `gte` of 7 aimed at the wrong field, or a `take` never applied,
 * would still pass. Running the filter means the exclusion assertions below
 * fail for the real reason: the row survived the query.
 */
function fakePrisma(rows: SeedReview[]) {
  const calls: FindManyArgs[] = [];

  const client = {
    review: {
      async findMany(args: FindManyArgs) {
        calls.push(args);
        const floor = args.where.rating.score.gte;
        return rows
          .filter((row) => row.score >= floor)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(0, args.take)
          .map((row) => ({
            id: row.id,
            body: row.body,
            isSpoiler: row.isSpoiler,
            createdAt: row.createdAt,
            album: {
              id: `album-${row.id}`,
              title: row.albumTitle,
              coverUrl: row.coverUrl,
              primaryArtist: { name: row.artistName },
            },
            user: { profile: row.profile },
            rating: { score: row.score },
            _count: { likes: row.likes, comments: row.comments },
          }));
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    lastCall: (): FindManyArgs => {
      const call = calls.at(-1);
      if (!call) throw new Error("review.findMany was never called.");
      return call;
    },
  };
}

function buildService(rows: SeedReview[]): {
  service: ReviewsService;
  lastCall: () => FindManyArgs;
} {
  const { prisma, lastCall } = fakePrisma(rows);
  const service = new ReviewsService(
    prisma,
    {} as unknown as NotificationsService,
  );
  return { service, lastCall };
}

/** Ids that sort deterministically, so the `id` tiebreak is observable. */
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * Unit test for the public landing page's `GET /reviews/popular` read
 * (`ReviewsService.popularReviews`). Kept in its own file rather than appended
 * to `reviews.service.spec.ts`: this is a standalone landing-page work unit
 * with its own Prisma double, and the review-social spec is already carrying
 * the like/comment write paths.
 */
describe("ReviewsService.popularReviews", () => {
  it("projects an eligible review into the landing-page card shape", async () => {
    const { service } = buildService([seed()]);

    const popular = await service.popularReviews();

    expect(popular).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        body: "A masterpiece, front to back.",
        isSpoiler: false,
        score: 9,
        createdAt: "2026-07-25T10:00:00.000Z",
        album: {
          id: "album-11111111-1111-4111-8111-111111111111",
          title: "OK Computer",
          coverUrl: "https://cdn.example/ok-computer.jpg",
          primaryArtistName: "Radiohead",
        },
        author: {
          username: "author",
          displayName: "The Author",
          avatarUrl: null,
        },
        likeCount: 4,
        commentCount: 2,
      },
    ]);
  });

  it("excludes a review rated below the score floor and keeps the boundary score", async () => {
    const { service } = buildService([
      seed({ id: ID_A, score: 6, body: "Underwhelming." }),
      seed({ id: ID_B, score: POPULAR_REVIEW_MIN_SCORE, body: "Solid." }),
    ]);

    const popular = await service.popularReviews();

    // The score-6 row was dropped by the query, not by an empty seed.
    expect(popular.map((review) => review.body)).toEqual(["Solid."]);
    expect(popular[0].score).toBe(POPULAR_REVIEW_MIN_SCORE);
  });

  it("orders by createdAt descending with an id tiebreak, newest first", async () => {
    const older = seed({
      id: ID_A,
      body: "Older.",
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
    });
    const newer = seed({
      id: ID_B,
      body: "Newer.",
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
    });
    const { service, lastCall } = buildService([older, newer]);

    const popular = await service.popularReviews();

    expect(popular.map((review) => review.body)).toEqual(["Newer.", "Older."]);
    expect(lastCall().orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("bounds the read to the default limit with no cursor in the payload", async () => {
    const rows = Array.from(
      { length: DEFAULT_POPULAR_REVIEW_LIMIT + 5 },
      (_, i) =>
        seed({
          id: `${i}`.padStart(8, "0") + "-0000-4000-8000-000000000000",
          createdAt: new Date(Date.UTC(2026, 6, 1, 0, 0, i)),
        }),
    );
    const { service, lastCall } = buildService(rows);

    const popular = await service.popularReviews();

    expect(popular).toHaveLength(DEFAULT_POPULAR_REVIEW_LIMIT);
    expect(lastCall().take).toBe(DEFAULT_POPULAR_REVIEW_LIMIT);
  });

  it("honours a caller limit but clamps it to the maximum", async () => {
    const { service, lastCall } = buildService([seed()]);

    await service.popularReviews(3);
    expect(lastCall().take).toBe(3);

    await service.popularReviews(MAX_POPULAR_REVIEW_LIMIT + 50);
    expect(lastCall().take).toBe(MAX_POPULAR_REVIEW_LIMIT);
  });

  it("parses a query-string limit and falls back on an unusable one", async () => {
    const { service, lastCall } = buildService([seed()]);

    // Express hands query params over as strings.
    await service.popularReviews("5");
    expect(lastCall().take).toBe(5);

    await service.popularReviews("not-a-number");
    expect(lastCall().take).toBe(DEFAULT_POPULAR_REVIEW_LIMIT);

    await service.popularReviews(0);
    expect(lastCall().take).toBe(DEFAULT_POPULAR_REVIEW_LIMIT);
  });

  it("degrades a review whose author has no profile row instead of throwing", async () => {
    const { service } = buildService([seed({ profile: null })]);

    const popular = await service.popularReviews();

    expect(popular[0].author).toEqual({
      username: "",
      displayName: "",
      avatarUrl: null,
    });
  });
});

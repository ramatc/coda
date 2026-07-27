import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ReviewsService } from "../src/reviews/reviews.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const AUTHOR_CLERK = "clerk_author";
const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER_CLERK = "clerk_viewer";
const VIEWER_ID = "22222222-2222-4222-8222-222222222222";
const UNSYNCED_CLERK = "clerk_unsynced";
const REVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UNKNOWN_REVIEW_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COMMENT_ID_1 = "10000000-0000-4000-8000-000000000001";
const COMMENT_ID_2 = "10000000-0000-4000-8000-000000000002";

const ALBUM = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "OK Computer",
  coverUrl: "https://cdn.coda.test/ok.jpg",
  primaryArtist: { name: "Radiohead" },
};

const AUTHOR_PROFILE = {
  username: "author",
  displayName: "The Author",
  avatarUrl: "https://cdn.coda.test/author.png",
};

const VIEWER_PROFILE = {
  username: "viewer",
  displayName: "The Viewer",
  avatarUrl: null,
};

interface StoredReview {
  id: string;
  userId: string;
  body: string;
  isSpoiler: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredComment {
  id: string;
  reviewId: string;
  userId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredLike {
  userId: string;
  reviewId: string;
}

interface CommentOrderBy {
  createdAt?: "asc" | "desc";
  id?: "asc" | "desc";
}

/**
 * In-memory Prisma stand-in honouring the exact queries the read path issues:
 * `user.findUnique` by clerk id, `review.findUnique` with the detail select
 * (album + author profile + `_count` + ordered comments), and
 * `reviewLike.findUnique` on the composite `userId_reviewId` key. Proves the
 * viewer-resolution matrix deterministically without a live Postgres (the
 * project's no-docker sandbox convention, mirroring lists/social service specs).
 *
 * `userLookups` records every `user.findUnique` argument so a test can prove the
 * anonymous path short-circuits BEFORE touching Prisma — the design's
 * load-bearing gotcha (`findUnique({ where: { clerkUserId: undefined } })`
 * raises `PrismaClientValidationError` → a 500 on every anonymous hit).
 */
function createFakePrisma() {
  const usersByClerk = new Map<string, string>();
  const profilesByUserId = new Map<string, typeof AUTHOR_PROFILE>();
  const reviews: StoredReview[] = [];
  const comments: StoredComment[] = [];
  const likes: StoredLike[] = [];
  const userLookups: (string | undefined)[] = [];
  const likeLookups: { userId: string; reviewId: string }[] = [];

  function sortComments(rows: StoredComment[], orderBy: CommentOrderBy[]) {
    return [...rows].sort((a, b) => {
      for (const clause of orderBy) {
        const direction = clause.createdAt ?? clause.id ?? "asc";
        const sign = direction === "desc" ? -1 : 1;
        const delta = clause.createdAt
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.id.localeCompare(b.id);
        if (delta !== 0) return delta * sign;
      }
      return 0;
    });
  }

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        userLookups.push(args.where.clerkUserId);
        const id = usersByClerk.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    review: {
      async findUnique(args: {
        where: { id: string };
        select: { comments: { orderBy: CommentOrderBy[] } };
      }): Promise<Record<string, unknown> | null> {
        const review = reviews.find((r) => r.id === args.where.id);
        if (!review) return null;
        const own = comments.filter((c) => c.reviewId === review.id);
        return {
          id: review.id,
          body: review.body,
          isSpoiler: review.isSpoiler,
          createdAt: review.createdAt,
          updatedAt: review.updatedAt,
          album: ALBUM,
          user: { profile: profilesByUserId.get(review.userId) ?? null },
          _count: {
            likes: likes.filter((l) => l.reviewId === review.id).length,
            comments: own.length,
          },
          comments: sortComments(own, args.select.comments.orderBy).map(
            (c) => ({
              id: c.id,
              userId: c.userId,
              body: c.body,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
              user: { profile: profilesByUserId.get(c.userId) ?? null },
            }),
          ),
        };
      },
    },
    reviewLike: {
      async findUnique(args: {
        where: { userId_reviewId: { userId: string; reviewId: string } };
      }): Promise<{ userId: string } | null> {
        const key = args.where.userId_reviewId;
        likeLookups.push(key);
        const hit = likes.find(
          (l) => l.userId === key.userId && l.reviewId === key.reviewId,
        );
        return hit ? { userId: hit.userId } : null;
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    usersByClerk,
    profilesByUserId,
    reviews,
    comments,
    likes,
    userLookups,
    likeLookups,
  };
}

const REVIEW_CREATED_AT = new Date("2026-07-25T10:00:00.000Z");
const REVIEW_UPDATED_AT = new Date("2026-07-25T11:00:00.000Z");
const COMMENT_1_AT = new Date("2026-07-26T09:00:00.000Z");
const COMMENT_2_AT = new Date("2026-07-26T10:00:00.000Z");

describe("ReviewsService.getReview", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: ReviewsService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new ReviewsService(fake.prisma);
    fake.usersByClerk.set(AUTHOR_CLERK, AUTHOR_ID);
    fake.usersByClerk.set(VIEWER_CLERK, VIEWER_ID);
    fake.profilesByUserId.set(AUTHOR_ID, AUTHOR_PROFILE);
    fake.profilesByUserId.set(VIEWER_ID, VIEWER_PROFILE);
    fake.reviews.push({
      id: REVIEW_ID,
      userId: AUTHOR_ID,
      body: "A masterpiece, front to back.",
      isSpoiler: false,
      createdAt: REVIEW_CREATED_AT,
      updatedAt: REVIEW_UPDATED_AT,
    });
  });

  function seedComments(): void {
    // Seeded newest-first on purpose so the returned order proves the service
    // asked Prisma for `createdAt asc` rather than accepting insertion order.
    fake.comments.push({
      id: COMMENT_ID_2,
      reviewId: REVIEW_ID,
      userId: VIEWER_ID,
      body: "Second, by the viewer.",
      createdAt: COMMENT_2_AT,
      updatedAt: COMMENT_2_AT,
    });
    fake.comments.push({
      id: COMMENT_ID_1,
      reviewId: REVIEW_ID,
      userId: AUTHOR_ID,
      body: "First, by the author.",
      createdAt: COMMENT_1_AT,
      updatedAt: COMMENT_1_AT,
    });
  }

  it("returns the full anonymous payload without ever looking the caller up in Prisma", async () => {
    seedComments();
    fake.likes.push({ userId: VIEWER_ID, reviewId: REVIEW_ID });

    const detail = await service.getReview(undefined, REVIEW_ID);

    expect(detail).toEqual({
      id: REVIEW_ID,
      body: "A masterpiece, front to back.",
      isSpoiler: false,
      createdAt: REVIEW_CREATED_AT.toISOString(),
      updatedAt: REVIEW_UPDATED_AT.toISOString(),
      album: {
        id: ALBUM.id,
        title: "OK Computer",
        coverUrl: "https://cdn.coda.test/ok.jpg",
        primaryArtistName: "Radiohead",
      },
      author: AUTHOR_PROFILE,
      likeCount: 1,
      commentCount: 2,
      comments: [
        {
          id: COMMENT_ID_1,
          body: "First, by the author.",
          createdAt: COMMENT_1_AT.toISOString(),
          updatedAt: COMMENT_1_AT.toISOString(),
          author: AUTHOR_PROFILE,
          isOwn: false,
        },
        {
          id: COMMENT_ID_2,
          body: "Second, by the viewer.",
          createdAt: COMMENT_2_AT.toISOString(),
          updatedAt: COMMENT_2_AT.toISOString(),
          author: VIEWER_PROFILE,
          isOwn: false,
        },
      ],
      viewer: { hasLiked: false, canInteract: false },
    });
    // The load-bearing anonymous-read contract: `undefined` must never reach a
    // Prisma `where` clause (it raises PrismaClientValidationError → 500).
    expect(fake.userLookups).toEqual([]);
    expect(fake.likeLookups).toEqual([]);
  });

  it("resolves a synced signed-in viewer: canInteract, hasLiked and isOwn all computed for real", async () => {
    seedComments();
    fake.likes.push({ userId: VIEWER_ID, reviewId: REVIEW_ID });

    const detail = await service.getReview(VIEWER_CLERK, REVIEW_ID);

    expect(fake.userLookups).toEqual([VIEWER_CLERK]);
    expect(detail.viewer).toEqual({ hasLiked: true, canInteract: true });
    expect(fake.likeLookups).toEqual([
      { userId: VIEWER_ID, reviewId: REVIEW_ID },
    ]);
    expect(detail.comments.map((comment) => comment.isOwn)).toEqual([
      false,
      true,
    ]);
  });

  it("reports hasLiked false for a synced viewer who has not liked the review", async () => {
    fake.likes.push({ userId: AUTHOR_ID, reviewId: REVIEW_ID });

    const detail = await service.getReview(VIEWER_CLERK, REVIEW_ID);

    expect(detail.viewer).toEqual({ hasLiked: false, canInteract: true });
    expect(detail.likeCount).toBe(1);
  });

  it("degrades a signed-in but unsynced caller to an anonymous viewer instead of throwing", async () => {
    seedComments();

    const detail = await service.getReview(UNSYNCED_CLERK, REVIEW_ID);

    expect(fake.userLookups).toEqual([UNSYNCED_CLERK]);
    expect(detail.viewer).toEqual({ hasLiked: false, canInteract: false });
    expect(detail.comments.every((comment) => comment.isOwn === false)).toBe(
      true,
    );
    // No local `User.id`, so there is nothing to key the like lookup on.
    expect(fake.likeLookups).toEqual([]);
  });

  it("rejects an unknown review id with 404", async () => {
    await expect(
      service.getReview(VIEWER_CLERK, UNKNOWN_REVIEW_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a malformed review id with 400 before it reaches Postgres", async () => {
    await expect(
      service.getReview(VIEWER_CLERK, "not-a-uuid"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.userLookups).toEqual([]);
  });

  it("returns zero counts and no comments for a review nobody engaged with", async () => {
    const detail = await service.getReview(undefined, REVIEW_ID);

    expect(detail.likeCount).toBe(0);
    expect(detail.commentCount).toBe(0);
    expect(detail.comments).toEqual([]);
  });
});

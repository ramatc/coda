import { beforeEach, describe, expect, it } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@coda/db";
import { ReviewsService } from "../src/reviews/reviews.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const AUTHOR_CLERK = "clerk_author";
const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER_CLERK = "clerk_viewer";
const VIEWER_ID = "22222222-2222-4222-8222-222222222222";
const UNSYNCED_CLERK = "clerk_unsynced";
const REVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_REVIEW_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UNKNOWN_REVIEW_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COMMENT_ID_1 = "10000000-0000-4000-8000-000000000001";
const COMMENT_ID_2 = "10000000-0000-4000-8000-000000000002";
const UNKNOWN_COMMENT_ID = "10000000-0000-4000-8000-000000000999";

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
 * Builds a P2002 unique-constraint error shaped like this project's Prisma 7
 * client (the REAL `@prisma/adapter-pg` driver-adapter shape — Decision #14).
 *
 * The composite `@@id([userId, reviewId])` is the SOLE unique constraint on
 * `review_likes`, so unlike `lists.addItem` / `want-to-listen` the service must
 * NOT discriminate on {@link extractUniqueConstraintField}: field attribution
 * would return the non-discriminating leading column (`user_id`) and add
 * brittleness for nothing (design Decision 5). The `constraint.fields` payload
 * is still populated here so the fake stays faithful to the real error shape.
 */
function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`user_id`,`review_id`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["user_id"] },
          },
        },
      },
    },
  );
}

/**
 * Builds a P2003 foreign-key violation shaped like this project's Prisma 7
 * client. A review deleted between page load and click (or a stale/shared link)
 * makes `ReviewLike.reviewId` / `ReviewComment.reviewId` point at nothing, and
 * the design requires that to surface as a 404 rather than a raw 500.
 */
function foreignKeyError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint failed on the field: `review_id`",
    { code: "P2003", clientVersion: "test" },
  );
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
 *
 * The write-path doubles enforce the REAL database constraints rather than
 * pre-checking in JavaScript, which is what makes the 409/404 mappings genuine
 * assertions: `reviewLike.create` throws P2002 when the composite PK is already
 * taken and P2003 when the review does not exist, and `reviewComment.create`
 * throws P2003 the same way. `afterCommentLoad` is a race seam — a test sets it
 * to delete the row between the authz load and the scoped write, proving the
 * `count === 0 → 404` net catches a lost race instead of a raw P2025 500.
 */
function createFakePrisma() {
  const usersByClerk = new Map<string, string>();
  const profilesByUserId = new Map<string, typeof AUTHOR_PROFILE>();
  const reviews: StoredReview[] = [];
  const comments: StoredComment[] = [];
  const likes: StoredLike[] = [];
  const userLookups: (string | undefined)[] = [];
  const likeLookups: { userId: string; reviewId: string }[] = [];
  const hooks: {
    afterCommentLoad?: () => void;
    afterCommentUpdate?: () => void;
  } = {};
  let commentSeq = 0;
  let clock = COMMENT_2_AT.getTime() + 60_000;

  /** Monotonic timestamps so newly written comments sort after the seeded ones. */
  const nextDate = (): Date => new Date((clock += 1000));
  const nextCommentId = (): string =>
    `10000000-0000-4000-8000-${String((commentSeq += 1) + 100).padStart(12, "0")}`;

  function projectComment(row: StoredComment) {
    return {
      id: row.id,
      userId: row.userId,
      body: row.body,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      user: { profile: profilesByUserId.get(row.userId) ?? null },
    };
  }

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
            projectComment,
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
      async create(args: {
        data: { userId: string; reviewId: string };
      }): Promise<StoredLike> {
        const { userId, reviewId } = args.data;
        // Real FK: the review must exist (P2003 → 404, design Decision 5).
        if (!reviews.some((r) => r.id === reviewId)) {
          throw foreignKeyError();
        }
        // Real composite PK: a second like is a constraint violation, never a
        // silent no-op (P2002 → 409). The DB is the single arbiter — no
        // pre-check, so there is no TOCTOU window to test around.
        if (likes.some((l) => l.userId === userId && l.reviewId === reviewId)) {
          throw uniqueConstraintError();
        }
        const row: StoredLike = { userId, reviewId };
        likes.push(row);
        return row;
      },
      async deleteMany(args: {
        where: { userId: string; reviewId: string };
      }): Promise<{ count: number }> {
        const { userId, reviewId } = args.where;
        let count = 0;
        for (let i = likes.length - 1; i >= 0; i -= 1) {
          if (likes[i].userId === userId && likes[i].reviewId === reviewId) {
            likes.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      },
      async count(args: { where: { reviewId: string } }): Promise<number> {
        return likes.filter((l) => l.reviewId === args.where.reviewId).length;
      },
    },
    reviewComment: {
      async create(args: {
        data: { reviewId: string; userId: string; body: string };
      }): Promise<Record<string, unknown>> {
        if (!reviews.some((r) => r.id === args.data.reviewId)) {
          throw foreignKeyError();
        }
        const now = nextDate();
        const row: StoredComment = {
          id: nextCommentId(),
          reviewId: args.data.reviewId,
          userId: args.data.userId,
          body: args.data.body,
          createdAt: now,
          updatedAt: now,
        };
        comments.push(row);
        return projectComment(row);
      },
      async findFirst(args: {
        where: { id: string; reviewId: string };
      }): Promise<Record<string, unknown> | null> {
        const row = comments.find(
          (c) => c.id === args.where.id && c.reviewId === args.where.reviewId,
        );
        // Race seam: fires AFTER the row is read, so a test can simulate a
        // concurrent delete landing between the authz check and the write.
        hooks.afterCommentLoad?.();
        return row ? projectComment(row) : null;
      },
      async updateMany(args: {
        where: { id: string; reviewId: string; userId: string };
        data: { body: string; updatedAt?: Date };
      }): Promise<{ count: number }> {
        const { id, reviewId, userId } = args.where;
        const row = comments.find(
          (c) => c.id === id && c.reviewId === reviewId && c.userId === userId,
        );
        if (!row) return { count: 0 };
        row.body = args.data.body;
        // Honours an explicit `updatedAt` exactly like Prisma does; the
        // `@updatedAt` auto-stamp only applies when the caller omits it.
        row.updatedAt = args.data.updatedAt ?? nextDate();
        // Concurrency seam: fires AFTER this request's write, where a re-read
        // of the row would have run. A test uses it to land a second request's
        // edit in that window.
        hooks.afterCommentUpdate?.();
        return { count: 1 };
      },
      async deleteMany(args: {
        where: { id: string; reviewId: string; userId: string };
      }): Promise<{ count: number }> {
        const { id, reviewId, userId } = args.where;
        const index = comments.findIndex(
          (c) => c.id === id && c.reviewId === reviewId && c.userId === userId,
        );
        if (index === -1) return { count: 0 };
        comments.splice(index, 1);
        return { count: 1 };
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
    hooks,
  };
}

const REVIEW_CREATED_AT = new Date("2026-07-25T10:00:00.000Z");
const REVIEW_UPDATED_AT = new Date("2026-07-25T11:00:00.000Z");
const COMMENT_1_AT = new Date("2026-07-26T09:00:00.000Z");
const COMMENT_2_AT = new Date("2026-07-26T10:00:00.000Z");
/** Timestamp a simulated CONCURRENT edit stamps on the row — never this caller's. */
const CONCURRENT_UPDATED_AT = new Date("2030-01-01T00:00:00.000Z");

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

/**
 * Write-path suite (slice 3, PR1b-ii). Every endpoint here sits behind the plain
 * fail-closed `ClerkGuard` — `clerkUserId` is always a string — and every one
 * resolves the caller with `requireCallerId` (404 for an unsynced account),
 * NOT the read path's null-tolerant `resolveUserId`.
 */
describe("ReviewsService write path", () => {
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

  describe("likeReview", () => {
    it("creates the like and returns the refreshed count", async () => {
      const result = await service.likeReview(VIEWER_CLERK, REVIEW_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: true });
      expect(fake.likes).toEqual([{ userId: VIEWER_ID, reviewId: REVIEW_ID }]);
    });

    it("rejects a second like with 409, leaving the original row untouched", async () => {
      await service.likeReview(VIEWER_CLERK, REVIEW_ID);

      // Idempotency is a DATA-layer invariant (the composite PK guarantees no
      // second row); 409 is the HTTP-layer contract that the write was refused.
      await expect(
        service.likeReview(VIEWER_CLERK, REVIEW_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fake.likes).toEqual([{ userId: VIEWER_ID, reviewId: REVIEW_ID }]);
    });

    it("maps a like on a nonexistent review to 404, not a raw 500", async () => {
      // A review deleted between page load and click raises P2003; unmapped it
      // would escape as an unhandled 500 (design Decision 5, rev 3 A5).
      await expect(
        service.likeReview(VIEWER_CLERK, UNKNOWN_REVIEW_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.likes).toEqual([]);
    });

    it("allows the author to like their own review", async () => {
      const result = await service.likeReview(AUTHOR_CLERK, REVIEW_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: true });
    });

    it("404s a signed-in caller with no synced local account", async () => {
      // Writes require a synced account — unlike the read path, which degrades.
      await expect(
        service.likeReview(UNSYNCED_CLERK, REVIEW_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.likes).toEqual([]);
    });

    it("rejects a malformed review id with 400 before it reaches Postgres", async () => {
      await expect(
        service.likeReview(VIEWER_CLERK, "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.userLookups).toEqual([]);
    });
  });

  describe("unlikeReview", () => {
    it("removes the caller's like and returns the refreshed count", async () => {
      await service.likeReview(VIEWER_CLERK, REVIEW_ID);
      await service.likeReview(AUTHOR_CLERK, REVIEW_ID);

      const result = await service.unlikeReview(VIEWER_CLERK, REVIEW_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: false });
      expect(fake.likes).toEqual([{ userId: AUTHOR_ID, reviewId: REVIEW_ID }]);
    });

    it("is a tolerant no-op when the caller never liked the review", async () => {
      await service.likeReview(AUTHOR_CLERK, REVIEW_ID);

      // The spec never requires 409/404 on the unlike direction — do NOT
      // over-apply the like path's 409 here (design Decision 5).
      const result = await service.unlikeReview(VIEWER_CLERK, REVIEW_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: false });
      expect(fake.likes).toEqual([{ userId: AUTHOR_ID, reviewId: REVIEW_ID }]);
    });

    it("404s an unsynced caller", async () => {
      await expect(
        service.unlikeReview(UNSYNCED_CLERK, REVIEW_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("createComment", () => {
    it("creates the comment and returns it flagged as the caller's own", async () => {
      const comment = await service.createComment(VIEWER_CLERK, REVIEW_ID, {
        body: "  Completely agree.  ",
      });

      expect(comment).toMatchObject({
        body: "Completely agree.",
        author: VIEWER_PROFILE,
        isOwn: true,
      });
      expect(fake.comments).toHaveLength(1);
      expect(fake.comments[0].reviewId).toBe(REVIEW_ID);
      expect(fake.comments[0].userId).toBe(VIEWER_ID);
    });

    it("allows the review author to comment on their own review", async () => {
      const comment = await service.createComment(AUTHOR_CLERK, REVIEW_ID, {
        body: "Replying to my own take.",
      });

      expect(comment.isOwn).toBe(true);
    });

    it("accepts a body exactly at the 500-character limit", async () => {
      const comment = await service.createComment(VIEWER_CLERK, REVIEW_ID, {
        body: "x".repeat(500),
      });

      expect(comment.body).toHaveLength(500);
    });

    it("rejects a body over 500 characters with 400 and writes nothing", async () => {
      // Service-level validation, NOT DB truncation: `@db.VarChar(500)` would
      // raise a driver error, so the bound is enforced before the write.
      await expect(
        service.createComment(VIEWER_CLERK, REVIEW_ID, {
          body: "x".repeat(501),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.comments).toEqual([]);
    });

    it("rejects an empty or whitespace-only body with 400", async () => {
      await expect(
        service.createComment(VIEWER_CLERK, REVIEW_ID, { body: "   " }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createComment(VIEWER_CLERK, REVIEW_ID, { body: "" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createComment(VIEWER_CLERK, REVIEW_ID, { body: 42 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.comments).toEqual([]);
    });

    it("rejects a body made only of zero-width characters with 400", async () => {
      // `String.prototype.trim()` strips whitespace but NOT zero-width/format
      // code points, so a body of only U+200B/200C/200D/FEFF would otherwise
      // pass the emptiness check and persist a visually blank comment. Some
      // clipboard sources inject a stray ZWSP, so this is reachable through
      // ordinary use, not just deliberate abuse.
      await expect(
        service.createComment(VIEWER_CLERK, REVIEW_ID, {
          body: "\u200B\u200B\u200B",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createComment(VIEWER_CLERK, REVIEW_ID, {
          body: " \u200B\t\u200C\u200D \uFEFF ",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.comments).toEqual([]);
    });

    it("keeps a body whose zero-width characters sit alongside real text", async () => {
      // Only the ALL-invisible case is empty; stripping is an emptiness test,
      // not a sanitizer, so a body with visible text still persists verbatim.
      const comment = await service.createComment(VIEWER_CLERK, REVIEW_ID, {
        body: "Loved\u200B it.",
      });

      expect(comment.body).toBe("Loved\u200B it.");
    });

    it("maps a comment on an unknown review to 404, not a raw 500", async () => {
      await expect(
        service.createComment(VIEWER_CLERK, UNKNOWN_REVIEW_ID, {
          body: "Ghost comment.",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s an unsynced caller", async () => {
      await expect(
        service.createComment(UNSYNCED_CLERK, REVIEW_ID, { body: "Hi." }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.comments).toEqual([]);
    });
  });

  describe("updateComment", () => {
    async function seedViewerComment(): Promise<string> {
      const comment = await service.createComment(VIEWER_CLERK, REVIEW_ID, {
        body: "Original body.",
      });
      return comment.id;
    }

    it("updates the caller's own comment and returns the new body", async () => {
      const id = await seedViewerComment();

      const updated = await service.updateComment(VIEWER_CLERK, REVIEW_ID, id, {
        body: "Edited body.",
      });

      expect(updated).toMatchObject({ id, body: "Edited body.", isOwn: true });
      expect(fake.comments[0].body).toBe("Edited body.");
    });

    it("rejects a non-author with 403 and leaves the body unchanged", async () => {
      const id = await seedViewerComment();

      // Comments are public data, so a non-author edit is an authz failure
      // (403), not a hidden-existence 404 (design Decision 6).
      await expect(
        service.updateComment(AUTHOR_CLERK, REVIEW_ID, id, { body: "Hijack." }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fake.comments[0].body).toBe("Original body.");
    });

    it("404s a comment id that belongs to a DIFFERENT review", async () => {
      const id = await seedViewerComment();
      fake.reviews.push({
        id: OTHER_REVIEW_ID,
        userId: AUTHOR_ID,
        body: "Another review.",
        isSpoiler: false,
        createdAt: REVIEW_CREATED_AT,
        updatedAt: REVIEW_UPDATED_AT,
      });

      // The `reviewId` scoping is what stops a caller editing a comment on a
      // different review by supplying its id.
      await expect(
        service.updateComment(VIEWER_CLERK, OTHER_REVIEW_ID, id, {
          body: "Wrong parent.",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.comments[0].body).toBe("Original body.");
    });

    it("404s an unknown comment id", async () => {
      await expect(
        service.updateComment(VIEWER_CLERK, REVIEW_ID, UNKNOWN_COMMENT_ID, {
          body: "Nothing to edit.",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects an over-long edit with 400 and leaves the body unchanged", async () => {
      const id = await seedViewerComment();

      await expect(
        service.updateComment(VIEWER_CLERK, REVIEW_ID, id, {
          body: "x".repeat(501),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.comments[0].body).toBe("Original body.");
    });

    it("404s (not 500) when the comment is deleted between the authz load and the write", async () => {
      const id = await seedViewerComment();
      // Simulate a concurrent delete landing in the gap the two-step authz
      // opens. A bare `update()` would raise P2025 → 500; the scoped
      // `updateMany` + `count === 0` net turns it into an honest 404.
      fake.hooks.afterCommentLoad = () => {
        fake.comments.length = 0;
        delete fake.hooks.afterCommentLoad;
      };

      await expect(
        service.updateComment(VIEWER_CLERK, REVIEW_ID, id, { body: "Raced." }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns THIS request's own edit when a concurrent edit lands right after the write", async () => {
      const id = await seedViewerComment();
      // Two PATCHes from the SAME user (double-submit, or a second tab) race.
      // This one wins the `updateMany`, then the other lands in the window a
      // re-read would have used — so a re-read would hand this caller a 200
      // describing the OTHER request's body. The response must describe only
      // what THIS request wrote.
      let ownWrite: { body: string; updatedAt: Date } | undefined;
      fake.hooks.afterCommentUpdate = () => {
        ownWrite = {
          body: fake.comments[0].body,
          updatedAt: fake.comments[0].updatedAt,
        };
        fake.comments[0].body = "Concurrent body.";
        fake.comments[0].updatedAt = CONCURRENT_UPDATED_AT;
        delete fake.hooks.afterCommentUpdate;
      };

      const updated = await service.updateComment(VIEWER_CLERK, REVIEW_ID, id, {
        body: "My own edit.",
      });

      expect(ownWrite).toEqual({
        body: "My own edit.",
        updatedAt: expect.any(Date),
      });
      expect(updated).toMatchObject({
        id,
        body: "My own edit.",
        updatedAt: ownWrite!.updatedAt.toISOString(),
        isOwn: true,
      });
      // The concurrent row state must never leak into this caller's response.
      expect(updated.body).not.toBe("Concurrent body.");
      expect(updated.updatedAt).not.toBe(CONCURRENT_UPDATED_AT.toISOString());
    });

    it("stamps updatedAt from the request itself rather than re-reading the row", async () => {
      const id = await seedViewerComment();
      const before = Date.now();

      const updated = await service.updateComment(VIEWER_CLERK, REVIEW_ID, id, {
        body: "Edited body.",
      });

      // The write carries an explicit timestamp, so the persisted row and the
      // response agree without a third query observing `@updatedAt`.
      expect(updated.updatedAt).toBe(fake.comments[0].updatedAt.toISOString());
      expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(before);
    });
  });

  describe("deleteComment", () => {
    async function seedViewerComment(): Promise<string> {
      const comment = await service.createComment(VIEWER_CLERK, REVIEW_ID, {
        body: "Original body.",
      });
      return comment.id;
    }

    it("deletes the caller's own comment", async () => {
      const id = await seedViewerComment();

      await service.deleteComment(VIEWER_CLERK, REVIEW_ID, id);

      expect(fake.comments).toEqual([]);
    });

    it("rejects a non-author with 403 and keeps the row", async () => {
      const id = await seedViewerComment();

      await expect(
        service.deleteComment(AUTHOR_CLERK, REVIEW_ID, id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fake.comments).toHaveLength(1);
    });

    it("404s a comment id scoped to a different review", async () => {
      const id = await seedViewerComment();
      fake.reviews.push({
        id: OTHER_REVIEW_ID,
        userId: AUTHOR_ID,
        body: "Another review.",
        isSpoiler: false,
        createdAt: REVIEW_CREATED_AT,
        updatedAt: REVIEW_UPDATED_AT,
      });

      await expect(
        service.deleteComment(VIEWER_CLERK, OTHER_REVIEW_ID, id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.comments).toHaveLength(1);
    });

    it("404s a raced double delete instead of surfacing a P2025 500", async () => {
      const id = await seedViewerComment();
      fake.hooks.afterCommentLoad = () => {
        fake.comments.length = 0;
        delete fake.hooks.afterCommentLoad;
      };

      await expect(
        service.deleteComment(VIEWER_CLERK, REVIEW_ID, id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a malformed comment id with 400", async () => {
      await expect(
        service.deleteComment(VIEWER_CLERK, REVIEW_ID, "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it("keeps comments ordered createdAt asc, id asc after the write path adds new ones", async () => {
    // The read path's ordering is PR1b-i's contract; this proves the write path
    // feeds it rows that still come back oldest-first.
    const first = await service.createComment(VIEWER_CLERK, REVIEW_ID, {
      body: "First.",
    });
    const second = await service.createComment(AUTHOR_CLERK, REVIEW_ID, {
      body: "Second.",
    });

    const detail = await service.getReview(VIEWER_CLERK, REVIEW_ID);

    expect(detail.comments.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(detail.comments.map((c) => c.isOwn)).toEqual([true, false]);
    expect(detail.commentCount).toBe(2);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ReviewsController } from "../src/reviews/reviews.controller.js";
import type { ReviewsService } from "../src/reviews/reviews.service.js";
import { OptionalClerkGuard } from "../src/auth/optional-clerk.guard.js";
import { IS_PUBLIC_KEY } from "../src/auth/auth.types.js";

const REVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMMENT_ID = "10000000-0000-4000-8000-000000000001";

/**
 * Every handler that mutates state. These MUST stay behind the plain
 * fail-closed `ClerkGuard`: no `@Public()`, no `OptionalClerkGuard`.
 */
const WRITE_HANDLERS = [
  "likeReview",
  "unlikeReview",
  "createComment",
  "updateComment",
  "deleteComment",
] as const;

const detail = {
  id: REVIEW_ID,
  body: "A masterpiece, front to back.",
  isSpoiler: false,
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T11:00:00.000Z",
  album: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "OK Computer",
    coverUrl: null,
    primaryArtistName: "Radiohead",
  },
  author: { username: "author", displayName: "The Author", avatarUrl: null },
  likeCount: 0,
  commentCount: 0,
  comments: [],
  viewer: { hasLiked: false, canInteract: false },
};

const comment = {
  id: COMMENT_ID,
  body: "Completely agree.",
  createdAt: "2026-07-26T09:00:00.000Z",
  updatedAt: "2026-07-26T09:00:00.000Z",
  author: { username: "viewer", displayName: "The Viewer", avatarUrl: null },
  isOwn: true,
};

/** The handler names this controller currently exposes (own prototype methods). */
function handlerNames(): string[] {
  return Object.getOwnPropertyNames(ReviewsController.prototype).filter(
    (name) => name !== "constructor",
  );
}

/**
 * Unit test for {@link ReviewsController}. Two jobs:
 *
 * 1. Prove the handler is a thin pass-through to {@link ReviewsService},
 *    including the `undefined` caller id that only THIS controller can receive.
 * 2. Pin the exact placement of the two auth decorators. `@Public()` and
 *    `@UseGuards(OptionalClerkGuard)` are the app's only auth exemption: on the
 *    CLASS they would silently exempt every write endpoint added to this
 *    controller later (`ClerkGuard` reads them with
 *    `getAllAndOverride([handler, class])`). These assertions are the
 *    regression guard for that.
 */
describe("ReviewsController", () => {
  let getReview: ReturnType<typeof vi.fn>;
  let likeReview: ReturnType<typeof vi.fn>;
  let unlikeReview: ReturnType<typeof vi.fn>;
  let createComment: ReturnType<typeof vi.fn>;
  let updateComment: ReturnType<typeof vi.fn>;
  let deleteComment: ReturnType<typeof vi.fn>;
  let controller: ReviewsController;

  beforeEach(() => {
    getReview = vi.fn().mockResolvedValue(detail);
    likeReview = vi.fn().mockResolvedValue({ likeCount: 1, hasLiked: true });
    unlikeReview = vi.fn().mockResolvedValue({ likeCount: 0, hasLiked: false });
    createComment = vi.fn().mockResolvedValue(comment);
    updateComment = vi.fn().mockResolvedValue(comment);
    deleteComment = vi.fn().mockResolvedValue(undefined);
    controller = new ReviewsController({
      getReview,
      likeReview,
      unlikeReview,
      createComment,
      updateComment,
      deleteComment,
    } as unknown as ReviewsService);
  });

  it("GET /reviews/:id forwards the caller id and review id, returning the detail", async () => {
    const result = await controller.getReview("clerk_1", REVIEW_ID);

    expect(getReview).toHaveBeenCalledWith("clerk_1", REVIEW_ID);
    expect(result).toBe(detail);
  });

  it("forwards an anonymous caller as undefined instead of coercing it", async () => {
    const result = await controller.getReview(undefined, REVIEW_ID);

    expect(getReview).toHaveBeenCalledWith(undefined, REVIEW_ID);
    expect(result).toBe(detail);
  });

  it("marks getReview @Public() at METHOD level and never at class level", () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, ReviewsController.prototype.getReview),
    ).toBe(true);
    // A class-level @Public() would exempt every future write handler here.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ReviewsController)).toBe(
      undefined,
    );
  });

  it("applies OptionalClerkGuard to getReview at METHOD level and never at class level", () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        ReviewsController.prototype.getReview,
      ),
    ).toEqual([OptionalClerkGuard]);
    // A class-level optional guard would downgrade future writes to
    // anonymous-tolerant.
    expect(Reflect.getMetadata(GUARDS_METADATA, ReviewsController)).toBe(
      undefined,
    );
  });

  it("POST /reviews/:id/like forwards the caller and review id", async () => {
    const result = await controller.likeReview("clerk_1", REVIEW_ID);

    expect(likeReview).toHaveBeenCalledWith("clerk_1", REVIEW_ID);
    expect(result).toEqual({ likeCount: 1, hasLiked: true });
  });

  it("DELETE /reviews/:id/like forwards the caller and review id", async () => {
    const result = await controller.unlikeReview("clerk_1", REVIEW_ID);

    expect(unlikeReview).toHaveBeenCalledWith("clerk_1", REVIEW_ID);
    expect(result).toEqual({ likeCount: 0, hasLiked: false });
  });

  it("POST /reviews/:id/comments forwards the raw body to the service", async () => {
    const body = { body: "Completely agree." };

    const result = await controller.createComment("clerk_1", REVIEW_ID, body);

    // The body stays UNVALIDATED at this layer — all validation lives in the
    // service, which types it as `unknown` (no DTO/pipe in this codebase).
    expect(createComment).toHaveBeenCalledWith("clerk_1", REVIEW_ID, body);
    expect(result).toBe(comment);
  });

  it("PATCH /reviews/:id/comments/:commentId forwards both ids and the body", async () => {
    const body = { body: "Edited." };

    const result = await controller.updateComment(
      "clerk_1",
      REVIEW_ID,
      COMMENT_ID,
      body,
    );

    expect(updateComment).toHaveBeenCalledWith(
      "clerk_1",
      REVIEW_ID,
      COMMENT_ID,
      body,
    );
    expect(result).toBe(comment);
  });

  it("DELETE /reviews/:id/comments/:commentId forwards both ids", async () => {
    await controller.deleteComment("clerk_1", REVIEW_ID, COMMENT_ID);

    expect(deleteComment).toHaveBeenCalledWith(
      "clerk_1",
      REVIEW_ID,
      COMMENT_ID,
    );
  });

  it.each(WRITE_HANDLERS)(
    "keeps %s fail-closed: no @Public() and no OptionalClerkGuard",
    (name) => {
      const handler = ReviewsController.prototype[name];

      // The whole point of the dedicated module: the read's auth exemption must
      // never leak onto a write. @Public() here would let an anonymous caller
      // through the global guard; OptionalClerkGuard would additionally
      // downgrade the write to anonymous-tolerant instead of 401-ing.
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(undefined);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBe(undefined);
    },
  );

  it("exposes exactly the read handler plus the five write handlers", () => {
    // Pinning the surface so any handler added here later has to extend the
    // negative auth assertions above deliberately, rather than silently
    // inheriting no coverage.
    expect(handlerNames()).toEqual(["getReview", ...WRITE_HANDLERS]);
  });
});

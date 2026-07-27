import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ReviewsController } from "../src/reviews/reviews.controller.js";
import type { ReviewsService } from "../src/reviews/reviews.service.js";
import { OptionalClerkGuard } from "../src/auth/optional-clerk.guard.js";
import { IS_PUBLIC_KEY } from "../src/auth/auth.types.js";

const REVIEW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  let controller: ReviewsController;

  beforeEach(() => {
    getReview = vi.fn().mockResolvedValue(detail);
    controller = new ReviewsController({
      getReview,
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

  it("exposes exactly one handler in the read-path slice", () => {
    // Pinning the surface so the write-path slice (like/unlike + comment CRUD)
    // has to extend this spec deliberately: every handler added here MUST be
    // asserted free of @Public() and of OptionalClerkGuard.
    expect(handlerNames()).toEqual(["getReview"]);
  });
});

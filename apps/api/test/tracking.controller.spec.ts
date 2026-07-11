import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrackingController } from "../src/tracking/tracking.controller.js";
import type { TrackingService } from "../src/tracking/tracking.service.js";

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Unit tests for {@link TrackingController}: it is a thin pass-through to
 * {@link TrackingService} (the domain logic is covered in
 * `tracking.service.spec.ts`). These prove the controller forwards the verified
 * Clerk `sub` + request payload correctly, and — task 8.5 scope check — that no
 * reply/like/comment surface exists on the reviews/tracking route table.
 */
describe("TrackingController", () => {
  let markListened: ReturnType<typeof vi.fn>;
  let deleteListen: ReturnType<typeof vi.fn>;
  let rateAlbum: ReturnType<typeof vi.fn>;
  let deleteRating: ReturnType<typeof vi.fn>;
  let writeReview: ReturnType<typeof vi.fn>;
  let controller: TrackingController;

  beforeEach(() => {
    markListened = vi.fn().mockResolvedValue({});
    deleteListen = vi.fn().mockResolvedValue({});
    rateAlbum = vi.fn().mockResolvedValue({});
    deleteRating = vi.fn().mockResolvedValue({});
    writeReview = vi.fn().mockResolvedValue({});
    const service = {
      markListened,
      deleteListen,
      rateAlbum,
      deleteRating,
      writeReview,
    } as unknown as TrackingService;
    controller = new TrackingController(service);
  });

  it("forwards the listen mark with the caller's id and album id", async () => {
    await controller.markListened("clerk_1", { albumId: ALBUM_ID });
    expect(markListened).toHaveBeenCalledWith("clerk_1", ALBUM_ID);
  });

  it("forwards the listen delete with the caller's id and listen id", async () => {
    await controller.deleteListen("clerk_1", "listen_1");
    expect(deleteListen).toHaveBeenCalledWith("clerk_1", "listen_1");
  });

  it("forwards the rating write with the caller's id and body", async () => {
    const body = { albumId: ALBUM_ID, score: 7 };
    await controller.rateAlbum("clerk_1", body);
    expect(rateAlbum).toHaveBeenCalledWith("clerk_1", body);
  });

  it("forwards the rating delete with the caller's id and album id", async () => {
    await controller.deleteRating("clerk_1", ALBUM_ID);
    expect(deleteRating).toHaveBeenCalledWith("clerk_1", ALBUM_ID);
  });

  it("forwards the review write with the caller's id and body", async () => {
    const body = { albumId: ALBUM_ID, body: "text" };
    await controller.writeReview("clerk_1", body);
    expect(writeReview).toHaveBeenCalledWith("clerk_1", body);
  });

  it("exposes no reply/like/comment surface (task 8.5 scope check)", () => {
    const methods = Object.getOwnPropertyNames(
      TrackingController.prototype,
    ).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(
      [
        "deleteListen",
        "deleteRating",
        "markListened",
        "rateAlbum",
        "writeReview",
      ].sort(),
    );
    const forbidden = /reply|like|comment/i;
    expect(methods.some((m) => forbidden.test(m))).toBe(false);
  });
});

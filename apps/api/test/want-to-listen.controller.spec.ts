import { beforeEach, describe, expect, it, vi } from "vitest";
import { WantToListenController } from "../src/want-to-listen/want-to-listen.controller.js";
import type { WantToListenService } from "../src/want-to-listen/want-to-listen.service.js";

/**
 * Unit test for {@link WantToListenController}: it is a thin pass-through to
 * {@link WantToListenService} (the domain logic is covered in
 * `want-to-listen.service.spec.ts`). Proves each route forwards the
 * `ClerkGuard`-verified `@CurrentUser("sub")`, the `:albumId` / `:username` path
 * params, and the request body exactly as received, and returns the service
 * result unchanged.
 */
describe("WantToListenController", () => {
  let markAlbum: ReturnType<typeof vi.fn>;
  let unmarkAlbum: ReturnType<typeof vi.fn>;
  let getUserWantToListen: ReturnType<typeof vi.fn>;
  let controller: WantToListenController;

  const row = {
    id: "want-1",
    albumId: "album-1",
    createdAt: "2026-07-22T12:00:00.000Z",
  };

  beforeEach(() => {
    markAlbum = vi.fn().mockResolvedValue(row);
    unmarkAlbum = vi.fn().mockResolvedValue(undefined);
    getUserWantToListen = vi.fn().mockResolvedValue([]);
    const service = {
      markAlbum,
      unmarkAlbum,
      getUserWantToListen,
    } as unknown as WantToListenService;
    controller = new WantToListenController(service);
  });

  it("POST /want-to-listen forwards caller id and body, returning the created row", async () => {
    const body = { albumId: "album-1" };
    const result = await controller.markAlbum("clerk_1", body);

    expect(markAlbum).toHaveBeenCalledWith("clerk_1", body);
    expect(result).toBe(row);
  });

  it("DELETE /want-to-listen/:albumId forwards caller id and album id", async () => {
    await controller.unmarkAlbum("clerk_1", "album-1");

    expect(unmarkAlbum).toHaveBeenCalledWith("clerk_1", "album-1");
  });

  it("GET /users/:username/want-to-listen forwards the username, returning entries", async () => {
    const entries = [{ id: "want-1", albumId: "album-1" }];
    getUserWantToListen.mockResolvedValueOnce(entries);

    const result = await controller.getUserWantToListen("bob");

    expect(getUserWantToListen).toHaveBeenCalledWith("bob");
    expect(result).toBe(entries);
  });
});

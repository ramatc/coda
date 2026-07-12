import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlbumsController } from "../src/tracking/albums.controller.js";
import type { AlbumDetailService } from "../src/tracking/album-detail.service.js";

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Unit test for {@link AlbumsController}: it is a thin pass-through to
 * {@link AlbumDetailService} (the domain logic is covered in
 * `album-detail.service.spec.ts`). Proves `GET /albums/:id` forwards the
 * `ClerkGuard`-verified `@CurrentUser("sub")` and the route param exactly as
 * received.
 */
describe("AlbumsController", () => {
  let getAlbumDetail: ReturnType<typeof vi.fn>;
  let controller: AlbumsController;

  beforeEach(() => {
    getAlbumDetail = vi.fn().mockResolvedValue({});
    const service = { getAlbumDetail } as unknown as AlbumDetailService;
    controller = new AlbumsController(service);
  });

  it("forwards the caller's id and the album id param", async () => {
    await controller.getAlbum("clerk_1", ALBUM_ID);
    expect(getAlbumDetail).toHaveBeenCalledWith("clerk_1", ALBUM_ID);
  });
});

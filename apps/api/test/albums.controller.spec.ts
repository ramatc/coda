import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { IS_PUBLIC_KEY } from "../src/auth/auth.types.js";
import { OptionalClerkGuard } from "../src/auth/optional-clerk.guard.js";
import { AlbumsController } from "../src/tracking/albums.controller.js";
import type { AlbumDetailService } from "../src/tracking/album-detail.service.js";

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Unit test for {@link AlbumsController}: it is a thin pass-through to
 * {@link AlbumDetailService} (the domain logic is covered in
 * `album-detail.service.spec.ts`). Proves `GET /albums/:id` forwards
 * `@CurrentUser("sub")` (or `undefined` for an anonymous caller) and the route
 * param exactly as received, and pins its anonymous-read decorators.
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

  it("forwards an anonymous caller as undefined", async () => {
    await controller.getAlbum(undefined, ALBUM_ID);
    expect(getAlbumDetail).toHaveBeenCalledWith(undefined, ALBUM_ID);
  });

  it("marks getAlbum @Public() at METHOD level with OptionalClerkGuard, never at class level", () => {
    const handler = AlbumsController.prototype.getAlbum;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      OptionalClerkGuard,
    ]);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AlbumsController)).toBe(
      undefined,
    );
  });
});

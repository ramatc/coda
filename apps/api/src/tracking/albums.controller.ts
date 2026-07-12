import { Controller, Get, Param } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  AlbumDetailService,
  type AlbumDetail,
} from "./album-detail.service.js";

/**
 * Read-only album endpoint (PR9), behind the global {@link ClerkGuard}. Backs
 * the album detail page (`apps/web/app/albums/[id]`): `GET /albums/:id` returns
 * the album metadata, tracklist, aggregate rating, and the current viewer's own
 * tracking state in ONE response, so the server component makes a single
 * round-trip. `@CurrentUser("sub")` yields the verified Clerk user id used to
 * scope the viewer state. Unknown album id → 404; malformed id → 400.
 *
 * This is a read surface only — the mutation routes (listens/ratings/reviews)
 * live on {@link TrackingController}.
 */
@Controller("albums")
export class AlbumsController {
  constructor(private readonly albumDetail: AlbumDetailService) {}

  /** Album detail (metadata + tracklist + aggregate rating + viewer state). */
  @Get(":id")
  getAlbum(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<AlbumDetail> {
    return this.albumDetail.getAlbumDetail(clerkUserId, id);
  }
}

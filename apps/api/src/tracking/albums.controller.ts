import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { OptionalClerkGuard } from "../auth/optional-clerk.guard.js";
import { Public } from "../auth/public.decorator.js";
import {
  AlbumDetailService,
  type AlbumDetail,
} from "./album-detail.service.js";

/**
 * Read-only album endpoint (PR9). Backs the album detail page
 * (`apps/web/app/albums/[id]`): `GET /albums/:id` returns the album metadata,
 * tracklist, aggregate rating, and the current viewer's own tracking state in
 * ONE response, so the server component makes a single round-trip.
 *
 * The route is anonymous-readable so album pages can be public and indexable:
 * `@Public()` lets signed-out visitors past the global `ClerkGuard`, and
 * `OptionalClerkGuard` still resolves a signed-in viewer. `@CurrentUser("sub")`
 * is the verified Clerk user id, or `undefined` for an anonymous caller (who
 * gets an empty viewer state). Unknown album id → 404; malformed id → 400.
 * This controller owns no write endpoints.
 *
 * This is a read surface only — the mutation routes (listens/ratings/reviews)
 * live on {@link TrackingController}.
 */
@Controller("albums")
export class AlbumsController {
  constructor(private readonly albumDetail: AlbumDetailService) {}

  /** Album detail (metadata + tracklist + aggregate rating + viewer state). */
  @Public()
  @UseGuards(OptionalClerkGuard)
  @Get(":id")
  getAlbum(
    @CurrentUser("sub") clerkUserId: string | undefined,
    @Param("id") id: string,
  ): Promise<AlbumDetail> {
    return this.albumDetail.getAlbumDetail(clerkUserId, id);
  }
}

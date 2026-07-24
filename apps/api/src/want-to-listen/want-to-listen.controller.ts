import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  WantToListenService,
  type MarkInput,
  type WantToListenEntry,
  type WantToListenRow,
} from "./want-to-listen.service.js";

/**
 * Want-to-listen endpoints (Fase 2 slice 2), all behind the global `ClerkGuard`.
 * `@CurrentUser("sub")` yields the verified Clerk user id, which the service
 * maps to the local `User.id`, so a caller can only mark/unmark their own
 * backlog.
 *
 * - `POST   /want-to-listen`                    → mark an album (dup → `409`, `200`)
 * - `DELETE /want-to-listen/:albumId`           → unmark an album (owner only, `204`)
 * - `GET    /users/:username/want-to-listen`    → public backlog section (read-time resolved)
 *
 * The controller has NO class-level prefix so the routes carry their absolute
 * paths. All validation and access logic lives in {@link WantToListenService}.
 */
@Controller()
export class WantToListenController {
  constructor(private readonly wantToListen: WantToListenService) {}

  /** Marks an album as want-to-listen for the caller (duplicate → 409). */
  @Post("want-to-listen")
  @HttpCode(200)
  markAlbum(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: MarkInput,
  ): Promise<WantToListenRow> {
    return this.wantToListen.markAlbum(clerkUserId, body);
  }

  /** Removes the caller's own want-to-listen entry for an album. */
  @Delete("want-to-listen/:albumId")
  @HttpCode(204)
  unmarkAlbum(
    @CurrentUser("sub") clerkUserId: string,
    @Param("albumId") albumId: string,
  ): Promise<void> {
    return this.wantToListen.unmarkAlbum(clerkUserId, albumId);
  }

  /** The want-to-listen backlog shown on `:username`'s public profile. */
  @Get("users/:username/want-to-listen")
  getUserWantToListen(
    @Param("username") username: string,
  ): Promise<WantToListenEntry[]> {
    return this.wantToListen.getUserWantToListen(username);
  }
}

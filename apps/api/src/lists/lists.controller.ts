import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  ListsService,
  type CreateListInput,
  type ListDetail,
  type UpdateListInput,
} from "./lists.service.js";

/**
 * Curated-list endpoints (Fase 2 slice 2), all behind the global `ClerkGuard`.
 * `@CurrentUser("sub")` yields the verified Clerk user id, which the service
 * maps to the local `User.id`, so a caller can only mutate their own lists.
 *
 * - `POST   /lists`      → create a list (`201`)
 * - `GET    /lists/:id`  → read a list + items (visibility-scoped)
 * - `PATCH  /lists/:id`  → edit title/description/flags (owner only)
 * - `DELETE /lists/:id`  → delete a list + items (owner only, `204`)
 *
 * The controller has NO class-level prefix so the routes carry their absolute
 * paths. All validation and access logic lives in {@link ListsService}.
 */
@Controller()
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  /** Creates a list owned by the caller. */
  @Post("lists")
  createList(
    @CurrentUser("sub") clerkUserId: string,
    @Body() body: CreateListInput,
  ): Promise<ListDetail> {
    return this.lists.createList(clerkUserId, body);
  }

  /** Reads a single list with its ordered items (visibility-scoped). */
  @Get("lists/:id")
  getList(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<ListDetail> {
    return this.lists.getList(clerkUserId, id);
  }

  /** Edits the caller's own list (title/description/flags). */
  @Patch("lists/:id")
  updateList(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
    @Body() body: UpdateListInput,
  ): Promise<ListDetail> {
    return this.lists.updateList(clerkUserId, id, body);
  }

  /** Deletes the caller's own list (cascading to its items). */
  @Delete("lists/:id")
  @HttpCode(204)
  deleteList(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<void> {
    return this.lists.deleteList(clerkUserId, id);
  }
}

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
  type AddItemInput,
  type CreateListInput,
  type ListDetail,
  type ListSummary,
  type ReorderInput,
  type UpdateListInput,
} from "./lists.service.js";

/**
 * Curated-list endpoints (Fase 2 slice 2), all behind the global `ClerkGuard`.
 * `@CurrentUser("sub")` yields the verified Clerk user id, which the service
 * maps to the local `User.id`, so a caller can only mutate their own lists.
 *
 * - `POST   /lists`                      → create a list (`201`)
 * - `GET    /lists/:id`                  → read a list + items (visibility-scoped)
 * - `PATCH  /lists/:id`                  → edit title/description/flags (owner only)
 * - `DELETE /lists/:id`                  → delete a list + items (owner only, `204`)
 * - `GET    /users/:username/lists`      → profile lists (owner: all; else public)
 * - `POST   /lists/:id/items`            → add an album (owner only; dup → `409`, `200`)
 * - `DELETE /lists/:id/items/:itemId`    → remove an item, renumber (owner only)
 * - `PATCH  /lists/:id/items/reorder`    → reorder items to the given order (owner only)
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

  /** The lists shown on `:username`'s profile (owner: all; else public only). */
  @Get("users/:username/lists")
  getUserLists(
    @CurrentUser("sub") clerkUserId: string,
    @Param("username") username: string,
  ): Promise<ListSummary[]> {
    return this.lists.getUserLists(clerkUserId, username);
  }

  /** Adds an album to the caller's own list (duplicate → 409). */
  @Post("lists/:id/items")
  @HttpCode(200)
  addItem(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
    @Body() body: AddItemInput,
  ): Promise<ListDetail> {
    return this.lists.addItem(clerkUserId, id, body);
  }

  /**
   * Reorders the caller's own list to the exact order in the body. Declared
   * before the `:itemId` delete route is irrelevant (different verb), but the
   * literal `reorder` segment keeps this endpoint distinct from item deletes.
   */
  @Patch("lists/:id/items/reorder")
  reorder(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
    @Body() body: ReorderInput,
  ): Promise<ListDetail> {
    return this.lists.reorder(clerkUserId, id, body);
  }

  /** Removes an item from the caller's own list, renumbering the remainder. */
  @Delete("lists/:id/items/:itemId")
  removeItem(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
  ): Promise<ListDetail> {
    return this.lists.removeItem(clerkUserId, id, itemId);
  }
}

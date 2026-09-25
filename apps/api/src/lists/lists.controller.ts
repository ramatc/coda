import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { Public } from "../auth/public.decorator.js";
import {
  ListsService,
  type AddItemInput,
  type CreateListInput,
  type ListDetail,
  type ListLikeResult,
  type ListSummary,
  type PopularList,
  type ReorderInput,
  type UpdateListInput,
} from "./lists.service.js";

/**
 * Curated-list endpoints (Fase 2 slice 2). Every route is behind the global
 * `ClerkGuard` EXCEPT `GET /lists/popular`, the public landing page's read.
 * `@CurrentUser("sub")` yields the verified Clerk user id, which the service
 * maps to the local `User.id`, so a caller can only mutate their own lists.
 *
 * - `GET    /lists/popular`              → public landing top-N (anonymous OK)
 * - `POST   /lists`                      → create a list (`201`)
 * - `GET    /lists/:id`                  → read a list + items (visibility-scoped)
 * - `PATCH  /lists/:id`                  → edit title/description/flags (owner only)
 * - `DELETE /lists/:id`                  → delete a list + items (owner only, `204`)
 * - `GET    /users/:username/lists`      → profile lists (owner: all; else public)
 * - `POST   /lists/:id/items`            → add an album (owner only; dup → `409`, `200`)
 * - `DELETE /lists/:id/items/:itemId`    → remove an item, renumber (owner only)
 * - `PATCH  /lists/:id/items/reorder`    → reorder items to the given order (owner only)
 * - `POST   /lists/:id/like`             → like (`200`; duplicate → `409`)
 * - `DELETE /lists/:id/like`             → unlike (`200`, tolerant)
 *
 * The two like routes are the only ones here NOT scoped to the owner: liking is
 * a visitor action gated by the READ visibility rule, so any authenticated
 * caller who can see the list can like it (including its owner). See
 * {@link ListsService.likeList}.
 *
 * The controller has NO class-level prefix so the routes carry their absolute
 * paths. All validation and access logic lives in {@link ListsService}.
 *
 * ## `@Public()` is method-level only
 *
 * `popularLists` carries a bare `@Public()` on the HANDLER — never on the
 * class, and with no `OptionalClerkGuard`, because no field in its payload
 * depends on who is asking. `ClerkGuard` resolves the exemption with
 * `getAllAndOverride([handler, class])`, so a class-level `@Public()` here
 * would silently exempt every owner-only mutation above and every route added
 * later. `lists.controller.spec.ts` asserts this placement.
 *
 * ## Route order — read before reordering anything below
 *
 * `@Get("lists/popular")` MUST stay declared ABOVE `@Get("lists/:id")`. Nest
 * registers routes in declaration order, so with the two swapped the literal
 * request `/lists/popular` matches `:id` first: an anonymous caller is turned
 * away with a 401 and a signed-in one gets a 400 from the list-id UUID guard,
 * for a path that is not malformed at all. `lists.controller.spec.ts` pins the
 * order and `lists.e2e.spec.ts` proves the resulting 200 over the real router.
 */
@Controller()
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  /**
   * Bounded top-N of recent, well-stocked public lists for the public landing
   * page.
   *
   * Declared FIRST on purpose — see the route-order note on the class. `limit`
   * is `unknown` and reaches the service unvalidated, matching every other
   * handler here: all validation and clamping lives in {@link ListsService}.
   */
  @Public()
  @Get("lists/popular")
  popularLists(@Query("limit") limit?: unknown): Promise<PopularList[]> {
    return this.lists.popularLists(limit);
  }

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

  /**
   * Likes a list. `200` rather than `201` because the payload is a counter
   * projection, not a created-resource representation. A duplicate is a `409`;
   * a list the caller cannot see is a `404`.
   */
  @Post("lists/:id/like")
  @HttpCode(200)
  likeList(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<ListLikeResult> {
    return this.lists.likeList(clerkUserId, id);
  }

  /** Removes the caller's like. Tolerant: unliking what was never liked is a `200`. */
  @Delete("lists/:id/like")
  @HttpCode(200)
  unlikeList(
    @CurrentUser("sub") clerkUserId: string,
    @Param("id") id: string,
  ): Promise<ListLikeResult> {
    return this.lists.unlikeList(clerkUserId, id);
  }
}

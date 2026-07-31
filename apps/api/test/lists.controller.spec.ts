import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { ListsController } from "../src/lists/lists.controller.js";
import type { ListsService } from "../src/lists/lists.service.js";
import { IS_PUBLIC_KEY } from "../src/auth/auth.types.js";

/**
 * Unit test for {@link ListsController}: it is a thin pass-through to
 * {@link ListsService} (the domain logic is covered in `lists.service.spec.ts`).
 * Proves each route forwards the `ClerkGuard`-verified `@CurrentUser("sub")`, the
 * `:id` / `:username` path params, and the request body exactly as received, and
 * returns the service result unchanged.
 */
describe("ListsController", () => {
  let createList: ReturnType<typeof vi.fn>;
  let getList: ReturnType<typeof vi.fn>;
  let updateList: ReturnType<typeof vi.fn>;
  let deleteList: ReturnType<typeof vi.fn>;
  let getUserLists: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let removeItem: ReturnType<typeof vi.fn>;
  let reorder: ReturnType<typeof vi.fn>;
  let likeList: ReturnType<typeof vi.fn>;
  let unlikeList: ReturnType<typeof vi.fn>;
  let controller: ListsController;

  const detail = {
    id: "list-1",
    userId: "user-1",
    title: "Best of 2026",
    description: null,
    isRanked: false,
    isPublic: true,
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    items: [],
    likeCount: 0,
    viewerHasLiked: false,
  };

  beforeEach(() => {
    createList = vi.fn().mockResolvedValue(detail);
    getList = vi.fn().mockResolvedValue(detail);
    updateList = vi.fn().mockResolvedValue({ ...detail, title: "Renamed" });
    deleteList = vi.fn().mockResolvedValue(undefined);
    getUserLists = vi.fn().mockResolvedValue([]);
    addItem = vi.fn().mockResolvedValue({ ...detail, items: [{ id: "item-1" }] });
    removeItem = vi.fn().mockResolvedValue(detail);
    reorder = vi.fn().mockResolvedValue(detail);
    likeList = vi.fn().mockResolvedValue({ likeCount: 1, hasLiked: true });
    unlikeList = vi.fn().mockResolvedValue({ likeCount: 0, hasLiked: false });
    const service = {
      createList,
      getList,
      updateList,
      deleteList,
      getUserLists,
      addItem,
      removeItem,
      reorder,
      likeList,
      unlikeList,
    } as unknown as ListsService;
    controller = new ListsController(service);
  });

  it("POST /lists forwards caller id and body, returning the created detail", async () => {
    const body = { title: "Best of 2026", isPublic: true };
    const result = await controller.createList("clerk_1", body);

    expect(createList).toHaveBeenCalledWith("clerk_1", body);
    expect(result).toBe(detail);
  });

  it("GET /lists/:id forwards caller id and list id", async () => {
    const result = await controller.getList("clerk_1", "list-1");

    expect(getList).toHaveBeenCalledWith("clerk_1", "list-1");
    expect(result).toBe(detail);
  });

  it("PATCH /lists/:id forwards caller id, list id and body", async () => {
    const body = { title: "Renamed" };
    const result = await controller.updateList("clerk_1", "list-1", body);

    expect(updateList).toHaveBeenCalledWith("clerk_1", "list-1", body);
    expect(result).toEqual({ ...detail, title: "Renamed" });
  });

  it("DELETE /lists/:id forwards caller id and list id", async () => {
    await controller.deleteList("clerk_1", "list-1");

    expect(deleteList).toHaveBeenCalledWith("clerk_1", "list-1");
  });

  it("GET /users/:username/lists forwards caller id and username, returning summaries", async () => {
    const summaries = [{ id: "list-1", title: "Best of 2026" }];
    getUserLists.mockResolvedValueOnce(summaries);

    const result = await controller.getUserLists("clerk_1", "bob");

    expect(getUserLists).toHaveBeenCalledWith("clerk_1", "bob");
    expect(result).toBe(summaries);
  });

  it("POST /lists/:id/items forwards caller id, list id and body", async () => {
    const body = { albumId: "album-1", note: "opener" };
    const result = await controller.addItem("clerk_1", "list-1", body);

    expect(addItem).toHaveBeenCalledWith("clerk_1", "list-1", body);
    expect(result).toEqual({ ...detail, items: [{ id: "item-1" }] });
  });

  it("DELETE /lists/:id/items/:itemId forwards caller id, list id and item id", async () => {
    const result = await controller.removeItem("clerk_1", "list-1", "item-1");

    expect(removeItem).toHaveBeenCalledWith("clerk_1", "list-1", "item-1");
    expect(result).toBe(detail);
  });

  it("PATCH /lists/:id/items/reorder forwards caller id, list id and body", async () => {
    const body = { itemIds: ["item-2", "item-1"] };
    const result = await controller.reorder("clerk_1", "list-1", body);

    expect(reorder).toHaveBeenCalledWith("clerk_1", "list-1", body);
    expect(result).toBe(detail);
  });

  it("POST /lists/:id/like forwards caller id and list id, returning the counter projection", async () => {
    const result = await controller.likeList("clerk_1", "list-1");

    expect(likeList).toHaveBeenCalledWith("clerk_1", "list-1");
    expect(result).toEqual({ likeCount: 1, hasLiked: true });
  });

  it("DELETE /lists/:id/like forwards caller id and list id, returning the counter projection", async () => {
    const result = await controller.unlikeList("clerk_1", "list-1");

    expect(unlikeList).toHaveBeenCalledWith("clerk_1", "list-1");
    expect(result).toEqual({ likeCount: 0, hasLiked: false });
  });

  /**
   * Both like verbs answer `200`, not `201`/`204`: the payload is a counter
   * projection, not a created-resource representation and not an empty body.
   * Asserted through Nest's own metadata so a dropped `@HttpCode(200)` fails
   * here rather than silently changing the contract the web island depends on
   * — `POST` would otherwise default to `201`.
   */
  /**
   * The like routes stay behind the GLOBAL fail-closed `ClerkGuard`: neither
   * carries `@Public()` nor a route-scoped guard override, so an anonymous
   * caller is rejected before the handler runs.
   *
   * This is the regression net for the most plausible mistake in this slice.
   * `OptionalClerkGuard` was introduced for `GET /reviews/:id`, and these two
   * endpoints are the obvious place to wrongly copy it onto — they are the
   * "other" like routes. Doing so would silently downgrade a WRITE to
   * anonymous-tolerant, at which point `@CurrentUser("sub")` is `undefined`
   * and `requireCallerId` turns a missing 401 into a confusing 404.
   */
  it("keeps both like verbs behind the global ClerkGuard (no @Public, no guard override)", () => {
    for (const handler of [
      ListsController.prototype.likeList,
      ListsController.prototype.unlikeList,
    ]) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(undefined);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBe(undefined);
    }
    // Nothing at class level either — `ClerkGuard` resolves these with
    // `getAllAndOverride([handler, class])`, so a class-level exemption would
    // silently cover every list route including the owner-only mutations.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ListsController)).toBe(undefined);
    expect(Reflect.getMetadata(GUARDS_METADATA, ListsController)).toBe(
      undefined,
    );
  });

  it("answers 200 (not 201) on both like verbs", () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        ListsController.prototype.likeList,
      ),
    ).toBe(200);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        ListsController.prototype.unlikeList,
      ),
    ).toBe(200);
  });
});

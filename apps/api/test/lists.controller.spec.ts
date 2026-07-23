import { beforeEach, describe, expect, it, vi } from "vitest";
import { ListsController } from "../src/lists/lists.controller.js";
import type { ListsService } from "../src/lists/lists.service.js";

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
    const service = {
      createList,
      getList,
      updateList,
      deleteList,
      getUserLists,
      addItem,
      removeItem,
      reorder,
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
});

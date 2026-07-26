import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIST_NOT_FOUND,
  addListItem,
  createList,
  deleteList,
  fetchList,
  fetchViewerUserId,
  removeListItem,
  reorderListItems,
  updateList,
  type ListDetail,
} from "../lib/lists";

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

const LIST: ListDetail = {
  id: LIST_ID,
  userId: "44444444-4444-4444-8444-444444444444",
  title: "Best of 2026",
  description: "A ranked run through the year.",
  isRanked: true,
  isPublic: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
  items: [
    {
      id: ITEM_ID,
      position: 1,
      note: "opener",
      album: {
        id: ALBUM_ID,
        title: "Kid A",
        coverUrl: "https://cdn.example/kid-a.jpg",
        primaryArtistName: "Radiohead",
      },
    },
  ],
};

/** A JSON `Response` carrying the API's list-detail payload. */
function listResponse(status = 200): Response {
  return new Response(JSON.stringify(LIST), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A JSON `Response` carrying a Nest-shaped error body. */
function errorResponse(status: number, message?: unknown): Response {
  return new Response(JSON.stringify({ statusCode: status, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The `init` argument of the single recorded `fetch` call. */
function initOf(mock: ReturnType<typeof vi.spyOn>): RequestInit {
  return (mock.mock.calls[0]?.[1] ?? {}) as RequestInit;
}

/** The URL of the single recorded `fetch` call. */
function urlOf(mock: ReturnType<typeof vi.spyOn>): string {
  return String(mock.mock.calls[0]?.[0]);
}

/** The parsed JSON body of the single recorded `fetch` call. */
function bodyOf(mock: ReturnType<typeof vi.spyOn>): unknown {
  return JSON.parse(String(initOf(mock).body));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchList", () => {
  it("returns the list detail on a successful response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse());

    const result = await fetchList("test-token", LIST_ID);

    expect(result).toEqual(LIST);
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}`);
    expect(
      (initOf(fetchMock).headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("returns the LIST_NOT_FOUND sentinel on a 404 so the page can notFound()", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(404));

    expect(await fetchList("test-token", LIST_ID)).toBe(LIST_NOT_FOUND);
  });

  it("maps a private list's 404 the same way (existence is hidden, never 403)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(404, "List not found."),
    );

    expect(await fetchList(null, LIST_ID)).toBe(LIST_NOT_FOUND);
  });

  it("throws on any other non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(500));

    await expect(fetchList("test-token", LIST_ID)).rejects.toThrow(
      "Failed to load list (500)",
    );
  });
});

describe("fetchViewerUserId", () => {
  it("returns the caller's local user id from their own profile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ userId: "user-1", username: "ada" }), {
        status: 200,
      }),
    );

    expect(await fetchViewerUserId("test-token")).toBe("user-1");
    expect(urlOf(fetchMock)).toContain("/profile");
    expect(
      (initOf(fetchMock).headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("fails safe to null on a non-OK response so the page renders as a visitor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(404));

    expect(await fetchViewerUserId("test-token")).toBeNull();
  });

  it.each([401, 403, 404])(
    "does not retry a deterministic %i response — it is not transient",
    async (status) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(errorResponse(status));

      expect(await fetchViewerUserId("test-token")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry a successful response with an unparseable body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("not json", { status: 200 }));

    expect(await fetchViewerUserId("test-token")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails safe to null on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchViewerUserId(null)).toBeNull();
  });

  it("retries once after a transient failure and resolves to the real user id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ userId: "user-1", username: "ada" }), {
          status: 200,
        }),
      );

    expect(await fetchViewerUserId("test-token")).toBe("user-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still fails safe to null after two consecutive transient failures", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(errorResponse(500));

    expect(await fetchViewerUserId("test-token")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("createList", () => {
  it("POSTs the full create payload and returns the created list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse(201));

    const result = await createList("test-token", {
      title: "Best of 2026",
      description: "A ranked run through the year.",
      isRanked: true,
      isPublic: false,
    });

    expect(result).toEqual(LIST);
    expect(urlOf(fetchMock)).toContain("/lists");
    expect(initOf(fetchMock).method).toBe("POST");
    expect(bodyOf(fetchMock)).toEqual({
      title: "Best of 2026",
      description: "A ranked run through the year.",
      isRanked: true,
      isPublic: false,
    });
    const headers = initOf(fetchMock).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends a null description when none was typed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse(201));

    await createList("test-token", {
      title: "Untitled",
      description: null,
      isRanked: false,
      isPublic: true,
    });

    expect(bodyOf(fetchMock)).toEqual({
      title: "Untitled",
      description: null,
      isRanked: false,
      isPublic: true,
    });
  });

  it("surfaces the API's validation message on a 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(400, "title is required."),
    );

    await expect(
      createList("test-token", {
        title: "",
        description: null,
        isRanked: false,
        isPublic: true,
      }),
    ).rejects.toThrow("title is required.");
  });

  it("falls back to a generic message when the error body carries no string message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(500));

    await expect(
      createList("test-token", {
        title: "Best of 2026",
        description: null,
        isRanked: false,
        isPublic: true,
      }),
    ).rejects.toThrow("Could not create the list.");
  });
});

describe("updateList", () => {
  it("PATCHes only the supplied fields and returns the updated list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse());

    const result = await updateList("test-token", LIST_ID, {
      title: "Renamed",
      isPublic: false,
    });

    expect(result).toEqual(LIST);
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}`);
    expect(initOf(fetchMock).method).toBe("PATCH");
    expect(bodyOf(fetchMock)).toEqual({ title: "Renamed", isPublic: false });
  });

  it("surfaces the API's 403 message when a non-owner tries to edit a public list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(403, "You do not own this list."),
    );

    await expect(
      updateList("test-token", LIST_ID, { title: "Hijacked" }),
    ).rejects.toThrow("You do not own this list.");
  });
});

describe("deleteList", () => {
  it("DELETEs the list and resolves on the API's 204", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteList("test-token", LIST_ID)).resolves.toBeUndefined();
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}`);
    expect(initOf(fetchMock).method).toBe("DELETE");
  });

  it("throws with the API's message when the list is already gone", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(404, "List not found."),
    );

    await expect(deleteList("test-token", LIST_ID)).rejects.toThrow(
      "List not found.",
    );
  });
});

describe("addListItem", () => {
  it("POSTs the album id plus note and returns the refreshed list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse());

    const result = await addListItem("test-token", LIST_ID, ALBUM_ID, "opener");

    expect(result).toEqual(LIST);
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}/items`);
    expect(initOf(fetchMock).method).toBe("POST");
    expect(bodyOf(fetchMock)).toEqual({ albumId: ALBUM_ID, note: "opener" });
  });

  it("sends a null note when none was supplied", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse());

    await addListItem("test-token", LIST_ID, ALBUM_ID);

    expect(bodyOf(fetchMock)).toEqual({ albumId: ALBUM_ID, note: null });
  });

  it("surfaces the API's 409 duplicate message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(409, "This album is already on the list."),
    );

    await expect(
      addListItem("test-token", LIST_ID, ALBUM_ID),
    ).rejects.toThrow("This album is already on the list.");
  });
});

describe("removeListItem", () => {
  it("DELETEs the item scoped under its list and returns the renumbered list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse());

    const result = await removeListItem("test-token", LIST_ID, ITEM_ID);

    expect(result).toEqual(LIST);
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}/items/${ITEM_ID}`);
    expect(initOf(fetchMock).method).toBe("DELETE");
  });

  it("surfaces the API's message when the item is not on this list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(404, "List item not found."),
    );

    await expect(
      removeListItem("test-token", LIST_ID, ITEM_ID),
    ).rejects.toThrow("List item not found.");
  });
});

describe("reorderListItems", () => {
  it("PATCHes the FULL desired order to the reorder endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(listResponse());

    const result = await reorderListItems("test-token", LIST_ID, [
      "item-b",
      "item-a",
      "item-c",
    ]);

    expect(result).toEqual(LIST);
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}/items/reorder`);
    expect(initOf(fetchMock).method).toBe("PATCH");
    expect(bodyOf(fetchMock)).toEqual({
      itemIds: ["item-b", "item-a", "item-c"],
    });
  });

  it("surfaces the API's 400 when the order does not match the list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(400, "itemIds must list every item on the list exactly once."),
    );

    await expect(
      reorderListItems("test-token", LIST_ID, ["item-a"]),
    ).rejects.toThrow("itemIds must list every item on the list exactly once.");
  });

  it("surfaces the API's 409 when the list changed concurrently", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(409, "The list changed concurrently. Please retry."),
    );

    await expect(
      reorderListItems("test-token", LIST_ID, ["item-a", "item-b"]),
    ).rejects.toThrow("The list changed concurrently. Please retry.");
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>gateway</html>", { status: 502 }),
    );

    await expect(
      reorderListItems("test-token", LIST_ID, ["item-a"]),
    ).rejects.toThrow("Could not save the new order.");
  });
});

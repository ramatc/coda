import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIST_NOT_FOUND,
  ListActionError,
  addListItem,
  createList,
  deleteList,
  fetchList,
  fetchUserLists,
  fetchViewerOwnLists,
  fetchViewerProfile,
  fetchViewerUserId,
  likeList,
  removeListItem,
  reorderListItems,
  unlikeList,
  updateList,
  type ListDetail,
  type ListLikeResult,
  type ListSummary,
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
  likeCount: 2,
  viewerHasLiked: true,
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

/** The compact rows `GET /users/:username/lists` returns for a profile. */
const SUMMARIES: ListSummary[] = [
  {
    id: LIST_ID,
    title: "Best of 2026",
    description: "A ranked run through the year.",
    isRanked: true,
    isPublic: true,
    itemCount: 3,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    title: "Private drafts",
    description: null,
    isRanked: false,
    isPublic: false,
    itemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
];

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

/** A JSON `Response` carrying an arbitrary successful payload. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The `{ likeCount, hasLiked }` projection both like verbs answer with. */
const LIKE_RESULT: ListLikeResult = { likeCount: 3, hasLiked: true };

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

  it("carries the like projection through onto the ListDetail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(listResponse());

    const list = (await fetchList("test-token", LIST_ID)) as ListDetail;

    // Both fields are READ from the payload, never derived: `viewerHasLiked`
    // describes the caller who sent the token, so deriving it client-side is
    // impossible. Pinning them here keeps this module's mirror honest against
    // the API's own `ListDetail` (`apps/api/src/lists/lists.service.ts`).
    expect(list.likeCount).toBe(2);
    expect(list.viewerHasLiked).toBe(true);
  });
});

describe("likeList", () => {
  it("POSTs to the list's like route and returns the counter projection", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(LIKE_RESULT));

    expect(await likeList("test-token", LIST_ID)).toEqual(LIKE_RESULT);
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}/like`);
    expect(initOf(fetchMock).method).toBe("POST");
    expect(
      (initOf(fetchMock).headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("throws a 409 carrying the API's duplicate-like message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(409, "You already liked this list."),
    );

    const error = await likeList("test-token", LIST_ID).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ListActionError);
    expect((error as ListActionError).status).toBe(409);
    expect((error as ListActionError).message).toBe(
      "You already liked this list.",
    );
  });

  it("throws a 404 for a list the viewer may not see", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(404, "List not found."),
    );

    const error = await likeList("test-token", LIST_ID).catch(
      (err: unknown) => err,
    );

    // The API hides a private list behind a 404 rather than a 403, so this is
    // the same status a list DELETED mid-request produces — the island cannot
    // and need not tell them apart, it reconciles with the server either way.
    expect((error as ListActionError).status).toBe(404);
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>gateway</html>", { status: 502 }),
    );

    const error = await likeList("test-token", LIST_ID).catch(
      (err: unknown) => err,
    );

    // The status still has to survive: it is what separates a reconcilable
    // answer (409/404) from a genuine fault the island must show as an error.
    expect((error as ListActionError).status).toBe(502);
    expect((error as ListActionError).message).toBe(
      "Could not like this list.",
    );
  });

  it("escapes the list id it interpolates into the URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(LIKE_RESULT));

    await likeList("test-token", "not a/uuid");

    expect(urlOf(fetchMock)).toContain("/lists/not%20a%2Fuuid/like");
  });
});

describe("unlikeList", () => {
  it("DELETEs the like and returns the refreshed counter projection", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ likeCount: 2, hasLiked: false }));

    expect(await unlikeList("test-token", LIST_ID)).toEqual({
      likeCount: 2,
      hasLiked: false,
    });
    expect(urlOf(fetchMock)).toContain(`/lists/${LIST_ID}/like`);
    expect(initOf(fetchMock).method).toBe("DELETE");
  });

  it("resolves rather than throwing when the list was never liked", async () => {
    // Tolerant server-side by design: `unlikeList` is a scoped `deleteMany`,
    // so unliking something never liked is a 200 no-op, deliberately NOT the
    // 409 its like counterpart answers with. Do not mirror the 409 here.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ likeCount: 0, hasLiked: false }),
    );

    expect(await unlikeList("test-token", LIST_ID)).toEqual({
      likeCount: 0,
      hasLiked: false,
    });
  });

  it("throws a ListActionError carrying the status on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(500, "Internal server error"),
    );

    const error = await unlikeList("test-token", LIST_ID).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ListActionError);
    expect((error as ListActionError).status).toBe(500);
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

describe("fetchViewerProfile", () => {
  it("returns the caller's local id AND username from their own profile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ userId: "user-1", username: "ada" }), {
        status: 200,
      }),
    );

    expect(await fetchViewerProfile("test-token")).toEqual({
      userId: "user-1",
      username: "ada",
    });
    expect(urlOf(fetchMock)).toContain("/profile");
    expect(
      (initOf(fetchMock).headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("fails safe to null on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(404));

    expect(await fetchViewerProfile("test-token")).toBeNull();
  });

  it("fails safe to null on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchViewerProfile(null)).toBeNull();
  });

  it("fails safe to null when the body carries an id but no username", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ userId: "user-1" }), { status: 200 }),
    );

    expect(await fetchViewerProfile("test-token")).toBeNull();
  });

  it("retries once after a transient failure, like fetchViewerUserId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ userId: "user-1", username: "ada" }), {
          status: 200,
        }),
      );

    expect(await fetchViewerProfile("test-token")).toEqual({
      userId: "user-1",
      username: "ada",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a deterministic 401 — it is not transient", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(errorResponse(401));

    expect(await fetchViewerProfile("test-token")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchUserLists", () => {
  it("returns the profile's list summaries, public and private alike", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(SUMMARIES), { status: 200 }),
      );

    const result = await fetchUserLists("test-token", "ada");

    expect(result).toEqual(SUMMARIES);
    expect(result.map((summary) => summary.title)).toEqual([
      "Best of 2026",
      "Private drafts",
    ]);
    expect(urlOf(fetchMock)).toContain("/users/ada/lists");
    expect(
      (initOf(fetchMock).headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("encodes a username that needs escaping into the path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await fetchUserLists("test-token", "a da");

    expect(urlOf(fetchMock)).toContain("/users/a%20da/lists");
  });

  it("fails safe to an empty picker on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(404));

    expect(await fetchUserLists("test-token", "ghost")).toEqual([]);
  });

  it("fails safe to an empty picker on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchUserLists("test-token", "ada")).toEqual([]);
  });

  it("fails safe to an empty picker when the body is not an array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ lists: [] }), { status: 200 }),
    );

    expect(await fetchUserLists("test-token", "ada")).toEqual([]);
  });
});

describe("fetchViewerOwnLists", () => {
  it("resolves the viewer's own username, then the lists filed under it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ userId: "user-1", username: "ada" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(SUMMARIES), { status: 200 }),
      );

    expect(await fetchViewerOwnLists("test-token")).toEqual(SUMMARIES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/profile");
    // Keyed by the viewer's OWN username, so the API returns their private
    // lists too — a visitor's username would silently drop those.
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/users/ada/lists");
  });

  it("returns an empty picker without asking for lists when the viewer is unresolved", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(errorResponse(401));

    expect(await fetchViewerOwnLists("test-token")).toEqual([]);
    // Exactly one call: with no username there is no list URL to build, and
    // guessing one would ask the API about a user that does not exist.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

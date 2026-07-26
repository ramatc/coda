import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWantToListen,
  markWantToListen,
  unmarkWantToListen,
  type WantToListenEntry,
} from "../lib/want-to-listen";

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ALBUM_ID = "55555555-5555-4555-8555-555555555555";

const ENTRY: WantToListenEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  albumId: ALBUM_ID,
  createdAt: "2026-07-02T00:00:00.000Z",
  album: {
    id: ALBUM_ID,
    title: "Kid A",
    coverUrl: "https://cdn.example/kid-a.jpg",
    primaryArtistName: "Radiohead",
  },
};

const OTHER_ENTRY: WantToListenEntry = {
  id: "22222222-2222-4222-8222-222222222222",
  albumId: OTHER_ALBUM_ID,
  createdAt: "2026-07-01T00:00:00.000Z",
  album: {
    id: OTHER_ALBUM_ID,
    title: "Amnesiac",
    coverUrl: null,
    primaryArtistName: "Radiohead",
  },
};

/** A JSON `Response` carrying an arbitrary payload. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A JSON `Response` carrying a Nest-shaped error body. */
function errorResponse(status: number, message?: unknown): Response {
  return jsonResponse({ statusCode: status, message }, status);
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

describe("fetchWantToListen", () => {
  it("returns the profile's backlog entries, newest first, as the API sent them", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse([ENTRY, OTHER_ENTRY]));

    const result = await fetchWantToListen("test-token", "ada");

    expect(result).toEqual([ENTRY, OTHER_ENTRY]);
    expect(urlOf(fetchMock)).toContain("/users/ada/want-to-listen");
    expect(
      (initOf(fetchMock).headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("percent-encodes the username in the path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse([]));

    await fetchWantToListen("test-token", "ada lovelace");

    expect(urlOf(fetchMock)).toContain("/users/ada%20lovelace/want-to-listen");
  });

  it("returns an empty array when read-time resolve filtered every entry out", async () => {
    // The API answers 200 with `[]` for a user whose every marked album has
    // since been listened to or rated — an empty backlog, not a failure.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    expect(await fetchWantToListen("test-token", "ada")).toEqual([]);
  });

  it("fails safe to an empty section on a non-OK response instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(404, "No user found for username ada."),
    );

    expect(await fetchWantToListen("test-token", "ada")).toEqual([]);
  });

  it("fails safe to an empty section on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(await fetchWantToListen(null, "ada")).toEqual([]);
  });

  it("fails safe to an empty section when the body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>gateway</html>", { status: 200 }),
    );

    expect(await fetchWantToListen("test-token", "ada")).toEqual([]);
  });
});

describe("markWantToListen", () => {
  it("POSTs the album id and returns the created row", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: ENTRY.id,
        albumId: ALBUM_ID,
        createdAt: ENTRY.createdAt,
      }),
    );

    const result = await markWantToListen("test-token", ALBUM_ID);

    expect(result).toEqual({
      id: ENTRY.id,
      albumId: ALBUM_ID,
      createdAt: ENTRY.createdAt,
    });
    expect(urlOf(fetchMock)).toContain("/want-to-listen");
    expect(initOf(fetchMock).method).toBe("POST");
    expect(bodyOf(fetchMock)).toEqual({ albumId: ALBUM_ID });
    const headers = initOf(fetchMock).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("surfaces the API's 409 message when the album is already marked", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(409, "This album is already on your want-to-listen list."),
    );

    await expect(markWantToListen("test-token", ALBUM_ID)).rejects.toThrow(
      "This album is already on your want-to-listen list.",
    );
  });

  it("falls back to a generic message when the error body carries no string message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(errorResponse(500));

    await expect(markWantToListen("test-token", ALBUM_ID)).rejects.toThrow(
      "Could not add this album to your want-to-listen list.",
    );
  });
});

describe("unmarkWantToListen", () => {
  it("DELETEs the album's entry and resolves on the API's 204", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      unmarkWantToListen("test-token", ALBUM_ID),
    ).resolves.toBeUndefined();
    expect(urlOf(fetchMock)).toContain(`/want-to-listen/${ALBUM_ID}`);
    expect(initOf(fetchMock).method).toBe("DELETE");
    expect(
      (initOf(fetchMock).headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-token");
  });

  it("surfaces the API's 404 message when the entry is not the caller's", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errorResponse(404, "Want-to-listen entry not found."),
    );

    await expect(unmarkWantToListen("test-token", ALBUM_ID)).rejects.toThrow(
      "Want-to-listen entry not found.",
    );
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>gateway</html>", { status: 502 }),
    );

    await expect(unmarkWantToListen("test-token", ALBUM_ID)).rejects.toThrow(
      "Could not remove this album from your want-to-listen list.",
    );
  });
});

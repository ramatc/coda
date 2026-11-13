import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sitemap from "../app/sitemap";
import { fetchSitemapEntries } from "../lib/sitemap";

const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ENTRIES = {
  albums: [{ id: ALBUM_ID, updatedAt: "2026-10-01T08:00:00.000Z" }],
  lists: [{ id: LIST_ID, updatedAt: "2026-10-03T10:00:00.000Z" }],
};

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://coda.example");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.coda.example");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchSitemapEntries", () => {
  it("reads the public API endpoint without credentials", async () => {
    const fetchMock = stubFetch(json(ENTRIES));

    expect(await fetchSitemapEntries()).toEqual(ENTRIES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit | undefined,
    ];
    expect(url).toBe("https://api.coda.example/sitemap");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("degrades to no entries when the API answers with an error", async () => {
    stubFetch(json({ albums: ENTRIES.albums, lists: ENTRIES.lists }, 503));

    expect(await fetchSitemapEntries()).toEqual({ albums: [], lists: [] });
  });

  it("degrades to no entries when the API is unreachable", async () => {
    stubFetch(new Error("connect ECONNREFUSED"));

    expect(await fetchSitemapEntries()).toEqual({ albums: [], lists: [] });
  });

  it("degrades to no entries when the payload does not match the contract", async () => {
    stubFetch(json({ albums: [{ id: "not-a-uuid" }], lists: "nope" }));

    expect(await fetchSitemapEntries()).toEqual({ albums: [], lists: [] });
  });
});

describe("sitemap", () => {
  it("lists the landing page, every album and every public list as absolute URLs", async () => {
    stubFetch(json(ENTRIES));

    const entries = await sitemap();

    expect(entries).toEqual([
      { url: "https://coda.example/" },
      {
        url: `https://coda.example/albums/${ALBUM_ID}`,
        lastModified: "2026-10-01T08:00:00.000Z",
      },
      {
        url: `https://coda.example/lists/${LIST_ID}`,
        lastModified: "2026-10-03T10:00:00.000Z",
      },
    ]);
  });

  it("still serves the landing page when the API is down", async () => {
    stubFetch(new Error("connect ECONNREFUSED"));

    expect(await sitemap()).toEqual([{ url: "https://coda.example/" }]);
  });
});

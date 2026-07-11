// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SearchExperience } from "../app/search/search-experience";
import type { PopularAlbum, SearchResults } from "../lib/search";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const POPULAR: PopularAlbum[] = [
  { id: "pop-1", title: "Popular Album", coverUrl: null, primaryArtistName: "Pop Artist" },
];

const RESULTS: SearchResults = {
  query: "radio",
  page: 1,
  limit: 20,
  albums: [
    {
      id: "album-1",
      title: "OK Computer",
      primaryArtistName: "Radiohead",
      coverUrl: null,
      releaseYear: 1997,
    },
  ],
  artists: [{ id: "artist-1", name: "Radiohead", imageUrl: null }],
  totalAlbums: 1,
  totalArtists: 1,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SearchExperience", () => {
  it("server-provided popular albums are shown before the user types", () => {
    render(<SearchExperience initialPopular={POPULAR} />);

    expect(screen.getByText("Popular Album")).toBeTruthy();
    // The "Popular" section heading (distinct from the album title text).
    expect(screen.getByRole("heading", { name: "Popular" })).toBeTruthy();
  });

  it("typing a query runs a debounced search and replaces the popular view with live results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => RESULTS }),
    );

    render(<SearchExperience initialPopular={POPULAR} />);

    fireEvent.change(screen.getByLabelText("Search the catalog"), {
      target: { value: "radio" },
    });

    await waitFor(() => expect(screen.getByText("OK Computer")).toBeTruthy(), {
      timeout: 2000,
    });
    // Live results replaced the popular list.
    expect(screen.queryByText("Popular Album")).toBeNull();
  });

  it("clearing the query returns to the popular view without hitting the API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => RESULTS });
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchExperience initialPopular={POPULAR} />);
    const input = screen.getByLabelText("Search the catalog");

    fireEvent.change(input, { target: { value: "radio" } });
    await waitFor(() => expect(screen.getByText("OK Computer")).toBeTruthy(), {
      timeout: 2000,
    });

    fireEvent.change(input, { target: { value: "" } });

    // Popular is back; the empty query did not trigger another fetch.
    expect(screen.getByText("Popular Album")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

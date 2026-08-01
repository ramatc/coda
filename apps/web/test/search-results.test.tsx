import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SearchResults } from "../app/search/search-results";
import type {
  AlbumSearchResult,
  ArtistSearchResult,
} from "../lib/search";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same spirit as mocking next/navigation elsewhere).
// Every prop other than `href` is forwarded rather than dropped, so
// `data-testid` and friends survive into the DOM — without that, a
// `getByTestId` on a link silently fails and a `not.toContain(testid)`
// assertion passes for the wrong reason.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const albums: AlbumSearchResult[] = [
  {
    id: "album-1",
    title: "OK Computer",
    primaryArtistName: "Radiohead",
    coverUrl: null,
    releaseYear: 1997,
  },
];
const artists: ArtistSearchResult[] = [
  { id: "artist-1", name: "Radiohead", imageUrl: null },
];

describe("SearchResults", () => {
  it("renders albums linking to their detail page and lists artists", () => {
    const html = renderToStaticMarkup(
      <SearchResults
        albumsHeading="Albums"
        albums={albums}
        artists={artists}
        emptyMessage="nothing"
      />,
    );

    expect(html).toContain("OK Computer");
    expect(html).toContain("Radiohead");
    // Album card links to the album detail route (built in PR9).
    expect(html).toContain('href="/albums/album-1"');
  });

  it("shows the empty message when there are no albums and no artists", () => {
    const html = renderToStaticMarkup(
      <SearchResults
        albumsHeading="Popular"
        albums={[]}
        emptyMessage="No albums in the catalog yet."
      />,
    );

    expect(html).toContain("No albums in the catalog yet.");
  });
});

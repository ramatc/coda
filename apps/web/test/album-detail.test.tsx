import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlbumDetailView } from "../app/albums/[id]/album-detail";
import type { AlbumDetail } from "../lib/albums";

/**
 * Smoke tests for the presentational album-detail card. Being a pure,
 * synchronous component (the container/presentational split keeps data-fetching
 * + Clerk out of it), it renders to static HTML without a request context — the
 * same pattern as the profile-view / search-results tests.
 */
const baseAlbum: AlbumDetail = {
  id: "album-1",
  title: "OK Computer",
  coverUrl: "https://cdn.coda.test/ok.jpg",
  releaseDate: "1997-06-16",
  releaseYear: 1997,
  trackCount: 12,
  primaryArtist: { id: "artist-1", name: "Radiohead" },
  genres: [{ id: "g1", slug: "alt-rock", name: "Alternative Rock" }],
  tracks: [
    { id: "t1", position: 1, title: "Airbag", durationMs: 284000 },
    { id: "t2", position: 2, title: "Paranoid Android", durationMs: 383000 },
  ],
  aggregateRating: { average: 8.5, count: 4 },
  viewer: { listened: false, listenId: null, score: null, review: null },
};

describe("AlbumDetailView", () => {
  it("renders metadata, tracklist and the aggregate rating", () => {
    const html = renderToStaticMarkup(<AlbumDetailView album={baseAlbum} />);

    expect(html).toContain("OK Computer");
    expect(html).toContain("Radiohead");
    expect(html).toContain("1997");
    expect(html).toContain("Alternative Rock");
    // Tracklist entries.
    expect(html).toContain("Airbag");
    expect(html).toContain("Paranoid Android");
    // Track durations formatted m:ss.
    expect(html).toContain("4:44");
    expect(html).toContain("6:23");
    // Aggregate rating summary.
    expect(html).toContain("8.5/10");
    expect(html).toContain("4 ratings");
  });

  it("shows a placeholder cover and 'Not rated yet' when there is no cover or rating", () => {
    const html = renderToStaticMarkup(
      <AlbumDetailView
        album={{
          ...baseAlbum,
          coverUrl: null,
          aggregateRating: { average: null, count: 0 },
        }}
      />,
    );

    expect(html).toContain("album-cover-placeholder");
    // The real cover <img> (exact testid) is absent — only the placeholder,
    // whose testid coincidentally shares the "album-cover" prefix.
    expect(html).not.toContain('data-testid="album-cover"');
    expect(html).toContain("Not rated yet");
  });

  it("renders the composed action island passed as children", () => {
    const html = renderToStaticMarkup(
      <AlbumDetailView album={baseAlbum}>
        <div>action-island</div>
      </AlbumDetailView>,
    );

    expect(html).toContain("action-island");
  });
});

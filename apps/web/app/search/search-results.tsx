import Link from "next/link";
import { albumHref } from "../../lib/search";
import type {
  AlbumSearchResult,
  ArtistSearchResult,
} from "../../lib/search";

interface SearchResultsProps {
  /** Section heading above the album grid (e.g. "Popular" or "Albums"). */
  albumsHeading: string;
  albums: AlbumSearchResult[];
  artists?: ArtistSearchResult[];
  /** Shown when there are no albums AND no artists. */
  emptyMessage: string;
}

/**
 * Presentational search results (container/presentational split): a pure,
 * synchronous component with no data-fetching. Renders an album grid and an
 * optional artist list; every album links to its detail page
 * (`/albums/[id]`, built in PR9 — the link target 404s until then, which is
 * the intended slice sequencing). The client island composes this with the
 * live query state; the server page composes it with the initial popular list.
 */
export function SearchResults({
  albumsHeading,
  albums,
  artists = [],
  emptyMessage,
}: SearchResultsProps) {
  if (albums.length === 0 && artists.length === 0) {
    return <p className="text-sm italic opacity-50">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-8">
      {artists.length > 0 ? (
        <section aria-label="Artists" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
            Artists
          </h2>
          <ul className="flex flex-wrap gap-2">
            {artists.map((artist) => (
              <li key={artist.id}>
                <span className="rounded-full border border-brand-200 bg-white px-4 py-2 text-sm">
                  {artist.name}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {albums.length > 0 ? (
        <section aria-label={albumsHeading} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
            {albumsHeading}
          </h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {albums.map((album) => (
              <li key={album.id}>
                <Link
                  href={albumHref(album.id)}
                  className="flex flex-col gap-2 rounded-card border border-brand-100 p-2 hover:border-brand-300"
                >
                  {album.coverUrl ? (
                    // Remote cover art rendered with a plain <img>; next/image
                    // remote-pattern config is deferred (same as the avatar).
                    <img
                      src={album.coverUrl}
                      alt={`${album.title} cover`}
                      className="aspect-square w-full rounded-card object-cover"
                      data-testid="album-cover"
                    />
                  ) : (
                    <div
                      className="flex aspect-square w-full items-center justify-center rounded-card bg-brand-100 text-xl font-semibold text-brand-700"
                      data-testid="album-cover-placeholder"
                    >
                      {album.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="line-clamp-1 text-sm font-medium">
                    {album.title}
                  </span>
                  <span className="line-clamp-1 text-xs opacity-70">
                    {album.primaryArtistName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

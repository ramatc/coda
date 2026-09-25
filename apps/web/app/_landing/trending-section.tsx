import Link from "next/link";
import { albumHref, type PopularAlbum } from "../../lib/search";

interface TrendingSectionProps {
  albums: PopularAlbum[];
}

const TRENDING_HEADING_ID = "landing-trending-heading";

/**
 * Trending albums on the public landing (`/`), fed by `GET /search/popular`.
 * The section carries `id="trending"`, the anchor both the hero's secondary
 * call to action and `PublicNav` link to, so the id is a contract and must not
 * change on its own.
 *
 * Adapts the Home dashboard's `PopularRow` card markup (horizontal scroll row
 * below `lg`, a one-row grid from `lg` up) to the landing's section frame.
 * Like that row, it deliberately shows no score and no #1/#2/#3 ranking, which
 * would misread a popularity heuristic as an official chart.
 *
 * Synchronous and presentational: the page fetches the albums and passes them
 * in. An empty array (the fetch helper fails safe to `[]`) keeps the section
 * and its anchor, and shows an empty state instead of a blank gap.
 */
export function TrendingSection({ albums }: TrendingSectionProps) {
  return (
    <section
      id="trending"
      aria-labelledby={TRENDING_HEADING_ID}
      className="scroll-mt-20 border-b border-border-subtle px-4 py-16 lg:px-6 lg:py-20"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col gap-8">
        <h2
          id={TRENDING_HEADING_ID}
          className="text-sm font-semibold uppercase tracking-wide text-text-secondary"
        >
          Trending tonight
        </h2>
        {albums.length === 0 ? (
          <p className="text-sm text-text-tertiary">
            Nothing is trending yet. Check back after tonight&apos;s first
            listens.
          </p>
        ) : (
          <ul className="scrollbar-hide flex gap-4 overflow-x-auto pb-1 lg:grid lg:grid-cols-6 lg:gap-5 lg:overflow-visible lg:pb-0">
            {albums.map((album) => (
              <li key={album.id} className="w-36 shrink-0 lg:w-full">
                <Link
                  href={albumHref(album.id)}
                  className="group flex flex-col gap-2"
                >
                  {album.coverUrl ? (
                    // Remote cover art rendered with a plain <img>; next/image
                    // remote-pattern config is deferred (same as `PopularRow`).
                    <img
                      src={album.coverUrl}
                      alt={`${album.title} cover`}
                      className="aspect-square w-full rounded-card object-cover"
                    />
                  ) : (
                    <div
                      className="flex aspect-square w-full items-center justify-center rounded-card bg-surface-2 text-lg font-semibold text-text-primary"
                      data-testid="trending-cover-placeholder"
                      aria-hidden="true"
                    >
                      {album.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="line-clamp-1 text-sm font-medium text-text-primary group-hover:underline">
                    {album.title}
                  </span>
                  <span className="line-clamp-1 text-xs text-text-secondary">
                    {album.primaryArtistName}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

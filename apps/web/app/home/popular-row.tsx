import Link from "next/link";
import { albumHref } from "../../lib/search";
import type { PopularAlbum } from "../../lib/search";

interface PopularRowProps {
  albums: PopularAlbum[];
}

/**
 * Row of popular albums for the Home dashboard. Reuses the discover page's
 * album-card convention (`lib/search.ts`'s `PopularAlbum` and `albumHref`).
 * Below `lg` it lays out as a horizontally-scrolling row (Home surfaces a
 * glance, not a full browse — that stays on `/search`); from `lg` up it
 * becomes a fixed one-row grid with large artwork, matching the desktop
 * "what is alive in music" treatment — deliberately no floating score and no
 * #1/#2/#3 ranking, which would misread this as an official chart.
 */
export function PopularRow({ albums }: PopularRowProps) {
  if (albums.length === 0) {
    return (
      <p className="text-sm italic opacity-60" data-testid="popular-empty">
        Nothing popular to show yet.
      </p>
    );
  }

  return (
    <ul className="scrollbar-hide flex gap-4 overflow-x-auto pb-1 lg:grid lg:grid-cols-6 lg:gap-5 lg:overflow-visible lg:pb-0">
      {albums.map((album) => (
        <li key={album.id} className="w-36 shrink-0 lg:w-full">
          <Link href={albumHref(album.id)} className="flex flex-col gap-2">
            {album.coverUrl ? (
              // Remote cover art rendered with a plain <img>; next/image
              // remote-pattern config is deferred (same as the search grid).
              <img
                src={album.coverUrl}
                alt={`${album.title} cover`}
                className="aspect-square w-full rounded-card object-cover"
                data-testid="popular-cover"
              />
            ) : (
              <div
                className="flex aspect-square w-full items-center justify-center rounded-card bg-surface-2 text-lg font-semibold text-text-primary"
                data-testid="popular-cover-placeholder"
                aria-hidden="true"
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
  );
}

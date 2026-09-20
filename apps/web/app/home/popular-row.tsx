import Link from "next/link";
import { albumHref } from "../../lib/search";
import type { PopularAlbum } from "../../lib/search";

interface PopularRowProps {
  albums: PopularAlbum[];
}

/**
 * Compact horizontal row of popular albums for the Home dashboard. Reuses the
 * discover page's album-card convention (`lib/search.ts`'s `PopularAlbum` and
 * `albumHref`) but lays it out as a horizontally-scrolling row instead of a
 * grid — Home surfaces a glance, not a full browse (that stays on `/search`).
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
    <ul className="scrollbar-hide flex gap-4 overflow-x-auto pb-1">
      {albums.map((album) => (
        <li key={album.id} className="w-36 shrink-0">
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

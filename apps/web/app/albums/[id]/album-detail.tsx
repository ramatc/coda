import type { ReactNode } from "react";
import type { AlbumDetail } from "../../../lib/albums";

interface AlbumDetailViewProps {
  album: AlbumDetail;
  /** The viewer's action island (mark listened / rate / review). */
  children?: ReactNode;
}

/** Formats a track duration in `m:ss`, or an em dash when unknown. */
function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "—";
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Formats the aggregate rating as `avg/10 (n)`, or a placeholder when unrated. */
function formatAggregate(average: number | null, count: number): string {
  if (average === null || count === 0) {
    return "Not rated yet";
  }
  const label = count === 1 ? "1 rating" : `${count} ratings`;
  return `${average.toFixed(1)}/10 · ${label}`;
}

/**
 * Presentational album detail (container/presentational split): a pure,
 * synchronous component with no data-fetching or auth concerns, so it renders
 * in a plain unit test. The async server page fetches the data and composes
 * this with the viewer's action island (passed as `children`).
 */
export function AlbumDetailView({ album, children }: AlbumDetailViewProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end">
        {album.coverUrl ? (
          // Remote cover art rendered with a plain <img>; next/image
          // remote-pattern config is deferred (same as the search grid).
          <img
            src={album.coverUrl}
            alt={`${album.title} cover`}
            width={192}
            height={192}
            className="h-48 w-48 rounded-card object-cover"
            data-testid="album-cover"
          />
        ) : (
          <div
            className="flex h-48 w-48 items-center justify-center rounded-card bg-brand-100 text-5xl font-semibold text-brand-700"
            data-testid="album-cover-placeholder"
          >
            {album.title.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold">{album.title}</h1>
          <p className="text-lg opacity-80">{album.primaryArtist.name}</p>
          <p className="text-sm opacity-60">
            {album.releaseYear ? <span>{album.releaseYear}</span> : null}
            {album.releaseYear && album.trackCount ? <span> · </span> : null}
            {album.trackCount ? (
              <span>
                {album.trackCount} track{album.trackCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </p>
          <p className="text-sm font-medium text-brand-600" data-testid="aggregate-rating">
            {formatAggregate(
              album.aggregateRating.average,
              album.aggregateRating.count,
            )}
          </p>
          {album.genres.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {album.genres.map((genre) => (
                <li
                  key={genre.id}
                  className="rounded-full border border-brand-200 px-3 py-1 text-xs opacity-80"
                >
                  {genre.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>

      {children ? (
        <section aria-label="Your tracking">{children}</section>
      ) : null}

      <section aria-label="Tracklist" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
          Tracklist
        </h2>
        {album.tracks.length > 0 ? (
          <ol className="flex flex-col divide-y divide-brand-100">
            {album.tracks.map((track) => (
              <li
                key={track.id}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="flex gap-3">
                  <span className="w-6 text-right opacity-50">
                    {track.position}
                  </span>
                  <span>{track.title}</span>
                </span>
                <span className="tabular-nums opacity-60">
                  {formatDuration(track.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm italic opacity-50">
            No tracklist available for this album yet.
          </p>
        )}
      </section>
    </main>
  );
}

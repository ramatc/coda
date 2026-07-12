import Link from "next/link";
import type { ActivityItem } from "../../lib/activity";

interface ActivityFeedProps {
  items: ActivityItem[];
}

/** Max characters of a review body shown in the feed before truncating. */
const REVIEW_SNIPPET_LENGTH = 80;

/**
 * Truncates a review body to a short feed snippet, or `null` when there is no
 * body to show (a stranded REVIEW event whose `Review` row was deleted, or an
 * empty/whitespace-only body).
 */
function reviewSnippet(reviewBody: string | null): string | null {
  if (!reviewBody) {
    return null;
  }
  const trimmed = reviewBody.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= REVIEW_SNIPPET_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, REVIEW_SNIPPET_LENGTH).trimEnd()}...`;
}

/** Human-readable verb for an activity item, orphan-safe for a null score. */
function activityLabel(item: ActivityItem): string {
  switch (item.type) {
    case "LISTEN":
      return "Listened to";
    case "RATING":
      // A stranded RATING event whose rating was deleted may carry no score
      // snapshot — fall back to the bare verb rather than rendering "null/10".
      return item.score === null ? "Rated" : `Rated ${item.score}/10`;
    case "REVIEW": {
      // A stranded REVIEW event whose Review row was deleted degrades to the
      // bare verb (reviewBody is null), same orphan-safe posture as RATING.
      const snippet = reviewSnippet(item.reviewBody);
      return snippet ? `Reviewed — "${snippet}"` : "Reviewed";
    }
    default:
      return "Tracked";
  }
}

/**
 * Presentational personal activity feed (container/presentational split): a
 * pure, synchronous component with no data-fetching or auth concerns, so it
 * renders in a plain unit test — the same pattern as `AlbumDetailView`. The
 * server page fetches the cursor-paginated page and passes the items here; each
 * entry links to the album's detail page (`/albums/[id]`). An empty stream
 * renders an explicit empty state rather than a blank page.
 */
export function ActivityFeed({ items }: ActivityFeedProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm italic opacity-60" data-testid="activity-empty">
        No activity yet. Listen to, rate, or review an album to see it here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-brand-100">
      {items.map((item) => (
        <li key={item.id} className="py-3">
          <Link
            href={`/albums/${item.album.id}`}
            className="flex items-center gap-4 rounded-card p-2 hover:bg-brand-50"
          >
            {item.album.coverUrl ? (
              // Remote cover art rendered with a plain <img>; next/image
              // remote-pattern config is deferred (same as the search grid).
              <img
                src={item.album.coverUrl}
                alt={`${item.album.title} cover`}
                className="h-14 w-14 rounded-card object-cover"
                data-testid="activity-cover"
              />
            ) : (
              <div
                className="flex h-14 w-14 items-center justify-center rounded-card bg-brand-100 text-lg font-semibold text-brand-700"
                data-testid="activity-cover-placeholder"
              >
                {item.album.title.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-brand-600">
                {activityLabel(item)}
              </span>
              <span className="text-sm font-semibold">{item.album.title}</span>
              <span className="text-xs opacity-70">
                {item.album.primaryArtistName}
              </span>
            </div>
            <time
              dateTime={item.occurredAt}
              className="ml-auto self-start text-xs tabular-nums opacity-50"
            >
              {item.occurredAt.slice(0, 10)}
            </time>
          </Link>
        </li>
      ))}
    </ul>
  );
}

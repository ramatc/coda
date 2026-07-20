import Link from "next/link";
import type { FeedItem } from "../../lib/feed";

interface FeedListProps {
  items: FeedItem[];
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

/** Human-readable verb for a feed item, orphan-safe for a null score. */
function feedLabel(item: FeedItem): string {
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
 * Display name for a feed actor, degrading to their `@username` when the profile
 * carries no display name (the API's `FeedActor` degrades a missing profile to
 * empty strings rather than throwing — mirror that orphan-safe posture here).
 */
function actorName(item: FeedItem): string {
  const displayName = item.actor.displayName.trim();
  return displayName.length > 0 ? displayName : `@${item.actor.username}`;
}

/**
 * Presentational followed-activity feed (container/presentational split): a pure,
 * synchronous component with no data-fetching or auth concerns, so it renders in a
 * plain unit test — the same pattern as `ActivityFeed`. The server page fetches
 * the cursor-paginated page and passes the items here. Unlike the personal
 * activity stream, each entry is attributed to its `actor` (the followed user who
 * produced the event), whose name links to their profile (`/u/[username]`); the
 * album links to its detail page (`/albums/[id]`). An empty feed renders an
 * explicit "follow people" empty state rather than a blank page.
 */
export function FeedList({ items }: FeedListProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm italic opacity-60" data-testid="feed-empty">
        Your feed is empty. Follow people to see what they listen to, rate, and
        review here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-brand-100">
      {items.map((item) => (
        <li key={item.id} className="flex flex-col gap-1 py-3">
          <Link
            href={`/u/${item.actor.username}`}
            className="flex w-fit items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline"
          >
            {item.actor.avatarUrl ? (
              // Remote avatar rendered with a plain <img>; next/image
              // remote-pattern config is deferred (same as the profile page).
              <img
                src={item.actor.avatarUrl}
                alt=""
                className="h-5 w-5 rounded-full object-cover"
                data-testid="feed-actor-avatar"
              />
            ) : (
              <span
                className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700"
                data-testid="feed-actor-avatar-placeholder"
                aria-hidden="true"
              >
                {actorName(item).charAt(0).toUpperCase()}
              </span>
            )}
            {actorName(item)}
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href={`/albums/${item.album.id}`}
              className="flex flex-1 items-center gap-4"
            >
              {item.album.coverUrl ? (
                // Remote cover art rendered with a plain <img>; next/image
                // remote-pattern config is deferred (same as the activity feed).
                <img
                  src={item.album.coverUrl}
                  alt=""
                  className="h-14 w-14 rounded-card object-cover"
                  data-testid="feed-cover"
                />
              ) : (
                <div
                  className="flex h-14 w-14 items-center justify-center rounded-card bg-brand-100 text-lg font-semibold text-brand-700"
                  data-testid="feed-cover-placeholder"
                  aria-hidden="true"
                >
                  {item.album.title.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-brand-600">
                  {feedLabel(item)}
                </span>
                <span className="text-sm font-semibold">
                  {item.album.title}
                </span>
                <span className="text-xs opacity-70">
                  {item.album.primaryArtistName}
                </span>
              </div>
            </Link>
            <time
              dateTime={item.occurredAt}
              className="ml-auto shrink-0 self-start text-xs tabular-nums opacity-50"
            >
              {item.occurredAt.slice(0, 10)}
            </time>
          </div>
        </li>
      ))}
    </ul>
  );
}

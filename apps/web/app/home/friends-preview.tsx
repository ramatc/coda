import Link from "next/link";
import { RatingScale } from "@coda/ui";
import type { FeedItem } from "../../lib/feed";
import { commentCountLabel, reviewPath } from "../../lib/reviews";

interface FriendsPreviewProps {
  /** Already sliced to a small preview count by the page — this component never truncates itself. */
  items: FeedItem[];
}

/** Max characters of a review body shown in the preview before truncating. */
const REVIEW_SNIPPET_LENGTH = 80;

/**
 * Display name for a feed actor, degrading to `@username` when the profile
 * carries no display name — mirrors `FeedList`'s own `actorName` helper.
 */
function actorName(item: FeedItem): string {
  const displayName = item.actor.displayName.trim();
  return displayName.length > 0 ? displayName : `@${item.actor.username}`;
}

/**
 * A short, lowercase verb for a feed item, orphan-safe for a null score — a
 * shorter twin of `FeedList`'s `feedLabel`, since this preview reads as one
 * inline sentence ("mati rated Rodeo"). Unlike `FeedList`, the score itself
 * is never embedded in this string — a present RATING score renders as a
 * `RatingScale` alongside the verb instead (see below), so this only ever
 * returns the bare verb.
 */
function previewVerb(item: FeedItem): string {
  switch (item.type) {
    case "LISTEN":
      return "listened to";
    case "RATING":
      return "rated";
    case "REVIEW":
      return "reviewed";
    default:
      return "tracked";
  }
}

/**
 * Truncates a review body to a short preview snippet, or `null` when there is
 * none to show — mirrors `ActivityFeed`'s own `reviewSnippet` helper.
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

/**
 * A small preview of followed-activity for the Home dashboard — deliberately
 * NOT the full feed (that stays at `/feed`, rendered by `FeedList`). Home only
 * needs a glance, so this duplicates `FeedList`'s tiny label helpers rather
 * than importing them (they are private to that module) — the copy here is
 * intentionally shorter and reads inline instead of as a labeled card.
 *
 * Every field rendered here (actor avatar, timestamp, review snippet, comment
 * count) was already present on `FeedItem` — this only surfaces it; nothing
 * new was added backend-side. Likes are deliberately NOT shown, matching the
 * design's "don't foreground likes" posture.
 */
export function FriendsPreview({ items }: FriendsPreviewProps) {
  if (items.length === 0) {
    return (
      <p
        className="text-sm italic opacity-60"
        data-testid="friends-preview-empty"
      >
        Follow people to see what they listen to, rate, and review here.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border-subtle">
      {items.map((item) => {
        const snippet =
          item.type === "REVIEW" ? reviewSnippet(item.reviewBody) : null;

        return (
          <li key={item.id} className="flex items-start gap-3 py-3">
            {item.actor.avatarUrl ? (
              <img
                src={item.actor.avatarUrl}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full object-cover"
                data-testid="friends-preview-actor-avatar"
              />
            ) : (
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-text-primary"
                data-testid="friends-preview-actor-avatar-placeholder"
                aria-hidden="true"
              >
                {actorName(item).charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="flex flex-wrap items-center gap-1 text-sm">
                <Link
                  href={`/u/${item.actor.username}`}
                  className="font-medium text-coda hover:underline"
                >
                  {actorName(item)}
                </Link>
                <span>{previewVerb(item)}</span>
                {item.score !== null ? (
                  <RatingScale
                    value={item.score}
                    variant="other"
                    size="sm"
                    showValue={false}
                  />
                ) : null}
                <Link
                  href={`/albums/${item.album.id}`}
                  className="font-medium hover:underline"
                >
                  {item.album.title}
                </Link>
                <time
                  dateTime={item.occurredAt}
                  className="ml-auto shrink-0 text-xs tabular-nums text-text-tertiary"
                >
                  {item.occurredAt.slice(0, 10)}
                </time>
              </p>
              {snippet ? (
                <p className="font-serif text-sm italic text-text-secondary">
                  "{snippet}"
                </p>
              ) : null}
              {item.reviewId !== null ? (
                <Link
                  href={reviewPath(item.reviewId)}
                  className="text-xs text-text-tertiary hover:text-text-secondary hover:underline"
                >
                  {commentCountLabel(item.reviewCommentCount ?? 0)}
                </Link>
              ) : null}
            </div>
            {item.album.coverUrl ? (
              // Remote cover art rendered with a plain <img>; next/image
              // remote-pattern config is deferred (same as the full feed).
              <img
                src={item.album.coverUrl}
                alt=""
                className="h-12 w-12 shrink-0 rounded-card object-cover"
                data-testid="friends-preview-cover"
              />
            ) : (
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-card bg-surface-2 text-base font-semibold text-text-primary"
                data-testid="friends-preview-cover-placeholder"
                aria-hidden="true"
              >
                {item.album.title.charAt(0).toUpperCase()}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

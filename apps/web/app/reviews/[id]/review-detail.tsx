import type { ReactNode } from "react";
import Link from "next/link";
import {
  EMPTY_COMMENTS_MESSAGE,
  commentCountLabel,
  likeCountLabel,
  type ReviewAuthor,
  type ReviewComment,
  type ReviewDetail,
} from "../../../lib/reviews";

interface ReviewDetailViewProps {
  review: ReviewDetail;
  /**
   * The like island, rendered next to the read-only counts. Handed down
   * UNCONDITIONALLY by the server page and NOT gated on
   * `review.viewer.canInteract` here: the island itself owns the anonymous
   * branch (it renders a sign-in affordance instead of a live control), so the
   * "can this viewer write?" decision stays in exactly ONE place. An anonymous
   * render simply receives no slot at all and falls back to the counts alone.
   */
  likeAction?: ReactNode;
  /** The add-a-comment island, above the comment list. See {@link likeAction}. */
  commentForm?: ReactNode;
  /**
   * Per-row control slot, invoked once per comment with THAT comment. A render
   * prop rather than a plain node because the edit/delete island is row-scoped:
   * it needs the comment's own `id` and `isOwn` to decide what to offer. Author-
   * vs-visitor is therefore decided by the island, exactly as for the two slots
   * above; this view only routes each comment to its own control.
   */
  commentAction?: (comment: ReviewComment) => ReactNode;
}

/**
 * Presentational review detail (container/presentational split): a pure,
 * synchronous component with no data-fetching or auth concerns, so it renders in
 * a plain unit test — the same shape as {@link ListDetailView}. The async server
 * page fetches `GET /reviews/:id` and composes this with the viewer's islands.
 *
 * The read path is IDENTICAL for anonymous and signed-in visitors: body, counts
 * and comments always render. That is the point of the route — `/reviews/[id]`
 * is the app's only anonymously-readable page, so nothing here may depend on a
 * resolved viewer. Only the live controls differ, and they arrive as slots.
 *
 * Cover art and author avatars are deliberately NOT rendered: this mirrors
 * `ListDetailView`'s text-first surface, and the payload's `coverUrl`/`avatarUrl`
 * are carried on the types purely to stay faithful to the API response.
 */
export function ReviewDetailView({
  review,
  likeAction,
  commentForm,
  commentAction,
}: ReviewDetailViewProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">
          <Link href={`/albums/${review.album.id}`}>{review.album.title}</Link>
        </h1>
        <p className="text-lg opacity-80">{review.album.primaryArtistName}</p>
        <p className="text-sm opacity-70" data-testid="review-byline">
          <span>Review by </span>
          <Link href={`/u/${review.author.username}`} className="font-medium">
            {authorName(review.author)}
          </Link>
          <span> · </span>
          <time dateTime={review.createdAt}>
            {review.createdAt.slice(0, 10)}
          </time>
        </p>
      </header>

      <section aria-label="Review" className="flex flex-col gap-3">
        {review.isSpoiler ? (
          <p
            role="note"
            data-testid="review-spoiler-warning"
            className="w-fit rounded-full border border-brand-200 px-3 py-1 text-xs font-medium uppercase tracking-wide opacity-80"
          >
            Contains spoilers
          </p>
        ) : null}
        <p className="whitespace-pre-line text-base" data-testid="review-body">
          {review.body}
        </p>
      </section>

      <section
        aria-label="Reactions"
        className="flex flex-wrap items-center gap-4"
      >
        <p className="text-sm opacity-70" data-testid="review-counts">
          <span>{likeCountLabel(review.likeCount)}</span>
          <span> · </span>
          <span>{commentCountLabel(review.commentCount)}</span>
        </p>
        {likeAction}
      </section>

      <section aria-label="Comments" className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
          Comments
        </h2>
        {commentForm}
        {review.comments.length === 0 ? (
          <p className="text-sm italic opacity-50">{EMPTY_COMMENTS_MESSAGE}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-brand-100">
            {review.comments.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 py-3 text-sm">
                <p className="flex items-center gap-2 text-xs opacity-70">
                  <Link
                    href={`/u/${entry.author.username}`}
                    className="font-medium"
                  >
                    {authorName(entry.author)}
                  </Link>
                  <time dateTime={entry.createdAt}>
                    {entry.createdAt.slice(0, 10)}
                  </time>
                </p>
                <p className="whitespace-pre-line" data-testid="comment-body">
                  {entry.body}
                </p>
                {commentAction ? commentAction(entry) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * Display name for a review or comment author, degrading to their `@username`
 * when the profile carries no usable display name. The API's `toAuthor` degrades
 * a missing `Profile` to EMPTY STRINGS rather than throwing, so an empty (or
 * whitespace-only) display name is a real payload the page must survive —
 * the same orphan-safe posture `feed-list.tsx` takes for a feed actor.
 */
function authorName(author: ReviewAuthor): string {
  const displayName = author.displayName.trim();
  return displayName.length > 0 ? displayName : `@${author.username}`;
}

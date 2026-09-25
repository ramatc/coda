import Link from "next/link";
import { RatingScale } from "@coda/ui";
import {
  commentCountLabel,
  likeCountLabel,
  reviewPath,
  type PopularReview,
} from "../../lib/reviews";
import { displayNameOrHandle } from "./display-name";

interface PopularReviewsSectionProps {
  reviews: PopularReview[];
}

const REVIEWS_HEADING_ID = "landing-reviews-heading";

/**
 * Popular reviews on the public landing (`/`), fed by `GET /reviews/popular`
 * (recent reviews whose author rated the album 7 or higher). The section
 * carries `id="reviews"`, the anchor `PublicNav` links to, so the id is a
 * contract and must not change on its own.
 *
 * Each card's title links to the review page, which is readable anonymously,
 * so a logged-out visitor can follow it without meeting the sign-in wall. The
 * score renders through the shared read-only `RatingScale` (hook-free, safe in
 * a Server Component). A spoiler-flagged review never shows its body here: the
 * landing has no reveal control, so the card only says it contains spoilers.
 *
 * Synchronous and presentational: the page fetches the reviews and passes them
 * in. An empty array (the fetch helper fails safe to `[]`) keeps the section
 * and its anchor, and shows an empty state instead of a blank gap.
 */
export function PopularReviewsSection({ reviews }: PopularReviewsSectionProps) {
  return (
    <section
      id="reviews"
      aria-labelledby={REVIEWS_HEADING_ID}
      className="scroll-mt-20 border-b border-border-subtle px-4 py-16 lg:px-6 lg:py-20"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col gap-8">
        <h2
          id={REVIEWS_HEADING_ID}
          className="text-sm font-semibold uppercase tracking-wide text-text-secondary"
        >
          Popular reviews
        </h2>
        {reviews.length === 0 ? (
          <p className="text-sm text-text-tertiary">
            No reviews to show yet. The first ones are being written tonight.
          </p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {reviews.map((review) => (
              <li
                key={review.id}
                className="flex flex-col gap-4 rounded-card border border-border-subtle bg-surface-1 p-5"
              >
                <div className="flex items-center gap-3">
                  {review.album.coverUrl ? (
                    // Remote cover art rendered with a plain <img>; next/image
                    // remote-pattern config is deferred (same as `PopularRow`).
                    <img
                      src={review.album.coverUrl}
                      alt={`${review.album.title} cover`}
                      className="h-14 w-14 shrink-0 rounded-card object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-card bg-surface-2 text-lg font-semibold text-text-primary"
                      data-testid="review-cover-placeholder"
                      aria-hidden="true"
                    >
                      {review.album.title.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <h3 className="line-clamp-1 text-base font-bold text-text-primary">
                      <Link
                        href={reviewPath(review.id)}
                        className="hover:underline"
                      >
                        {review.album.title}
                      </Link>
                    </h3>
                    <span className="line-clamp-1 text-xs text-text-secondary">
                      {review.album.primaryArtistName}
                    </span>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="line-clamp-1 text-sm font-medium text-text-primary">
                    {displayNameOrHandle(review.author)}
                  </span>
                  <RatingScale
                    value={review.score}
                    variant="aggregate"
                    size="sm"
                  />
                </div>
                {review.isSpoiler ? (
                  <p className="text-sm italic text-text-tertiary">
                    This review contains spoilers.
                  </p>
                ) : (
                  <p className="line-clamp-4 font-serif text-sm leading-relaxed text-text-secondary">
                    {review.body}
                  </p>
                )}
                <p className="mt-auto flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
                  <span>{likeCountLabel(review.likeCount)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{commentCountLabel(review.commentCount)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

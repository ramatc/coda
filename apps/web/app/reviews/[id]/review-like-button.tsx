"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import {
  ReviewActionError,
  likeCountLabel,
  likeReview,
  unlikeReview,
} from "../../../lib/reviews";
import { useAsyncAction } from "../../../lib/use-async-action";
import { ReviewSignInPrompt } from "./review-sign-in-prompt";

interface ReviewLikeButtonProps {
  /** The review being liked (path param for the API call). */
  reviewId: string;
  /** The server-rendered like total: both the seed and the re-sync baseline. */
  initialLikeCount: number;
  /** Whether the viewer had already liked it, as the server resolved it. */
  initialHasLiked: boolean;
  /** `false` for an anonymous, bad-token, or not-yet-synced viewer. */
  canInteract: boolean;
}

/**
 * Statuses that mean this island's picture of the world is STALE, so the server
 * page should be re-read after rolling back.
 *
 * - **409** — the like already exists server-side (the composite primary key
 *   makes a second row impossible), so the optimistic increment was simply
 *   wrong about the starting state.
 * - **404** — the review was deleted between render and click. Refreshing lets
 *   the SERVER PAGE surface the not-found state; this island deliberately does
 *   not try to tell that story itself.
 *
 * A 5xx is excluded on purpose: nothing is known to have changed server-side, so
 * a refresh would just be a second failing round trip.
 */
const RECONCILABLE_STATUSES: ReadonlySet<number> = new Set([409, 404]);

/**
 * Like/unlike island for a review (client). Mirrors `follow-button.tsx`: the
 * state flips OPTIMISTICALLY on click for instant feedback, then the request
 * settles.
 *
 * On success the SERVER's `{ likeCount, hasLiked }` is applied rather than the
 * optimistic guess — other people's likes may have landed in between, so the
 * count is corrected instead of trusted — and `router.refresh()` re-reads the
 * page so the read-only count in the header agrees. On failure the optimistic
 * flip is rolled back and the API's own message is surfaced inline.
 *
 * When `canInteract` is false the island renders a sign-in prompt instead of a
 * live control. That decision lives HERE, not in `review-detail.tsx`: the view
 * hands all three slots down unconditionally precisely so each island owns its
 * own anonymous branch, keeping "may this viewer write?" in one place per
 * control rather than duplicated across the view and the islands.
 */
export function ReviewLikeButton({
  reviewId,
  initialLikeCount,
  initialHasLiked,
  canInteract,
}: ReviewLikeButtonProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [liked, setLiked] = useState(initialHasLiked);
  const [count, setCount] = useState(initialLikeCount);
  const { busy, error, running, run } = useAsyncAction();

  // Re-sync from fresh server props after this island's own `router.refresh()`
  // lands, skipped while a request is in flight so it never stomps a pending
  // optimistic update.
  //
  // The in-flight test reads a REF, not state, which is why this effect needs no
  // `eslint-disable` for `exhaustive-deps`: refs are stable, so listing `running`
  // costs nothing and the dependency list stays honest — this runs exactly when
  // the server props change.
  useEffect(() => {
    if (!running.current) {
      setLiked(initialHasLiked);
      setCount(initialLikeCount);
    }
  }, [initialHasLiked, initialLikeCount, running]);

  async function toggle() {
    // Checked HERE as well as inside `run`, because the optimistic flip below
    // happens before the request starts: letting a rejected second click flip
    // local state would leave a change no request will ever settle.
    if (running.current) {
      return;
    }

    const previousLiked = liked;
    const previousCount = count;
    const next = !previousLiked;

    // Optimistic flip: reflect the intended state immediately.
    setLiked(next);
    setCount(previousCount + (next ? 1 : -1));

    await run(
      async () => {
        const token = await getToken();
        const result = next
          ? await likeReview(token, reviewId)
          : await unlikeReview(token, reviewId);

        // The server's count wins over the optimistic one.
        setLiked(result.hasLiked);
        setCount(result.likeCount);
        // The mutation already succeeded and the server's authoritative
        // result was already committed above, so a throwing `router.refresh()`
        // here must not escape into `run`'s outer catch: `onError` below would
        // unconditionally roll back to the PRE-click optimistic values,
        // reverting a successful like/unlike in the UI even though the server
        // recorded it correctly.
        try {
          router.refresh();
        } catch (refreshFailure) {
          console.error(
            "ReviewLikeButton: router.refresh() threw after a successful like/unlike",
            refreshFailure,
          );
        }
      },
      {
        onError: (caught) => {
          // Roll back — the mutation did not persist.
          setLiked(previousLiked);
          setCount(previousCount);

          if (
            caught instanceof ReviewActionError &&
            RECONCILABLE_STATUSES.has(caught.status)
          ) {
            router.refresh();
          }
        },
      },
    );
  }

  if (!canInteract) {
    return <ReviewSignInPrompt reviewId={reviewId} label="Sign in to like" />;
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={liked ? "Unlike this review" : "Like this review"}
        aria-pressed={liked}
        className={cn(
          buttonVariants({ variant: liked ? "default" : "outline" }),
          "w-fit",
        )}
      >
        <span data-testid="like-count">{likeCountLabel(count)}</span>
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

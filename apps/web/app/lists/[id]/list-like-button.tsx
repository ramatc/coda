"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { ListActionError, likeList, unlikeList } from "../../../lib/lists";

interface ListLikeButtonProps {
  /** The list being liked (path param for the API call). */
  listId: string;
  /** The server-rendered like total: both the seed and the re-sync baseline. */
  initialLikeCount: number;
  /** Whether the viewer had already liked it, as the server resolved it. */
  initialHasLiked: boolean;
}

/**
 * Statuses that mean this island's picture of the world is STALE, so the server
 * page should be re-read after rolling back. Identical to the set
 * `review-like-button.tsx` reconciles on, for the same two reasons:
 *
 * - **409** — the like already exists server-side (the composite primary key
 *   makes a second row impossible), so the optimistic increment was simply
 *   wrong about the starting state.
 * - **404** — the list is no longer visible to this viewer: deleted, or flipped
 *   to private, between render and click. The API's access check and its write
 *   are separate, non-transactional round trips, so this is genuinely reachable
 *   even for a list that rendered fine. Refreshing lets the SERVER PAGE surface
 *   the not-found state; this island deliberately does not tell that story
 *   itself.
 *
 * A 5xx is excluded on purpose: nothing is known to have changed server-side, so
 * a refresh would just be a second failing round trip.
 */
const RECONCILABLE_STATUSES: ReadonlySet<number> = new Set([409, 404]);

/**
 * `N likes`, singularized for a single like.
 *
 * Deliberately LOCAL rather than imported from `lib/reviews.ts` (which owns the
 * review-side twin) or added to `lib/lists.ts`: on this page only the island
 * renders a like count, so there is no server/client boundary for the copy to
 * straddle — which is exactly the reason the review twin lives in a lib module
 * and `albumCountLabel` does too. Importing across fetch modules for a string
 * formatter would be the lists UI's only dependency on the reviews module. If a
 * THIRD surface ever labels likes, move all of them to a shared module rather
 * than growing a second cross-import.
 */
function likeCountLabel(count: number): string {
  return count === 1 ? "1 like" : `${count} likes`;
}

/**
 * Like/unlike island for a list (client). The direct sibling of
 * `review-like-button.tsx` and intentionally the same shape: the state flips
 * OPTIMISTICALLY on click for instant feedback, then the request settles.
 *
 * On success the SERVER's `{ likeCount, hasLiked }` is applied rather than the
 * optimistic guess — other people's likes may have landed in between, so the
 * count is corrected instead of trusted — and `router.refresh()` re-reads the
 * page. On failure the optimistic flip is rolled back and the API's own message
 * is surfaced inline.
 *
 * Two deliberate DIFFERENCES from the review island, neither of which may be
 * "restored" for symmetry:
 *
 * 1. **No `canInteract` prop and no sign-in branch.** `/lists(.*)` is in
 *    `protectedRoutePatterns`, so a logged-out visitor never reaches the page
 *    that mounts this — unlike `/reviews/[id]`, the app's one anonymously
 *    readable route, whose islands each own an anonymous branch.
 * 2. **No ownership prop.** Self-like is allowed: the API gates likes on READ
 *    visibility (`loadListForViewer`), not on ownership, so an owner may like
 *    their own list. `list-detail.tsx` therefore renders this slot
 *    unconditionally, unlike its owner-only ones.
 */
export function ListLikeButton({
  listId,
  initialLikeCount,
  initialHasLiked,
}: ListLikeButtonProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [liked, setLiked] = useState(initialHasLiked);
  const [count, setCount] = useState(initialLikeCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous re-entrancy guard. `busy` drives the DISABLED attribute, but a
  // state update cannot be observed by a second handler firing in the same tick
  // — and three fast clicks sending like/unlike/like would leave the final
  // server state decided by whichever response happened to land last.
  const inFlight = useRef(false);

  // Re-sync from fresh server props after this island's own `router.refresh()`
  // lands, skipped while a request is in flight so it never stomps a pending
  // optimistic update. The guard reads a REF, so the dependency list stays
  // honest and needs no `exhaustive-deps` suppression.
  //
  // Clearing `error` here too (Judgment Day Round 1 fix) means ANY landed
  // refresh clears whatever error is currently showing, not just the one that
  // triggered it. ACCEPTED RISK (Judgment Day Round 2, judges split
  // theoretical/real, user accepted without a fix): two rapid clicks before
  // the first request's `router.refresh()` resolves could let its late-landing
  // props clear a second, still-relevant error. Requires a fast double
  // re-click plus specific network timing; not fixed with a generation guard
  // because it was judged low-priority relative to the stale-banner bug it
  // replaces.
  useEffect(() => {
    if (!inFlight.current) {
      setLiked(initialHasLiked);
      setCount(initialLikeCount);
      setError(null);
    }
  }, [initialHasLiked, initialLikeCount]);

  async function toggle() {
    if (inFlight.current) {
      return;
    }

    const previousLiked = liked;
    const previousCount = count;
    const next = !previousLiked;

    // Optimistic flip: reflect the intended state immediately.
    setLiked(next);
    setCount(previousCount + (next ? 1 : -1));
    inFlight.current = true;
    setBusy(true);
    setError(null);

    try {
      const token = await getToken();
      const result = next
        ? await likeList(token, listId)
        : await unlikeList(token, listId);

      // The server's count wins over the optimistic one.
      setLiked(result.hasLiked);
      setCount(result.likeCount);
      router.refresh();
    } catch (err) {
      // Roll back — the mutation did not persist.
      setLiked(previousLiked);
      setCount(previousCount);
      setError(err instanceof Error ? err.message : "Something went wrong.");

      if (
        err instanceof ListActionError &&
        RECONCILABLE_STATUSES.has(err.status)
      ) {
        router.refresh();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={liked ? "Unlike this list" : "Like this list"}
        aria-pressed={liked}
        className={cn(
          buttonVariants({ variant: liked ? "default" : "outline" }),
          "w-fit",
        )}
      >
        <span data-testid="list-like-count">{likeCountLabel(count)}</span>
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

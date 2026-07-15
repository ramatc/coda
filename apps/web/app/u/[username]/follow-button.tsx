"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { followUser, unfollowUser } from "../../../lib/social";

interface FollowButtonProps {
  /** The profile being followed/unfollowed (path param for the API call). */
  username: string;
  /** The viewer's current follow state (server-fetched initial value). */
  initialFollowing: boolean;
}

/**
 * Follow/unfollow island (client). Rendered only on ANOTHER user's profile — the
 * server page omits it entirely on the viewer's own profile, so there is no
 * self-follow affordance (spec: "Visiting own profile → no follow button").
 *
 * The follow state flips OPTIMISTICALLY on click for instant feedback, then the
 * request settles: on success it `router.refresh()`es so the server page
 * re-fetches the (now incremented/decremented) follower count and re-renders it
 * in place. Unlike `album-actions.tsx` (which reads its viewer booleans
 * straight from props each render), this component holds `following` in local
 * state so it can flip optimistically — so a `useEffect` re-syncs `following`
 * from `initialFollowing` whenever the prop changes (in practice, only after
 * this component's own `router.refresh()` lands with a fresh server value),
 * except while a toggle is still in flight, so it never stomps on a pending
 * optimistic update.
 * On failure it ROLLS BACK to the pre-click state and surfaces an inline error,
 * so a rejected request never leaves a phantom follow in the UI.
 */
export function FollowButton({ username, initialFollowing }: FollowButtonProps) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync from fresh server props after this component's own
  // `router.refresh()` lands. Skipped while `busy` is true so it doesn't
  // stomp on an in-flight optimistic toggle. Deliberately
  // keyed only on `initialFollowing` — reacting to `busy` too would re-run
  // this effect the moment a toggle finishes, racing the rollback/optimistic
  // state in `toggle()`.
  useEffect(() => {
    if (!busy) {
      setFollowing(initialFollowing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFollowing]);

  async function toggle() {
    const previous = following;
    const next = !previous;

    // Optimistic flip: reflect the intended state immediately.
    setFollowing(next);
    setBusy(true);
    setError(null);

    try {
      const token = await getToken();
      if (next) {
        await followUser(token, username);
      } else {
        await unfollowUser(token, username);
      }
      // Server re-fetches the counts so the follower total updates in the same
      // view without a full reload.
      router.refresh();
    } catch (err) {
      // Roll back the optimistic flip — the mutation did not persist.
      setFollowing(previous);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={
          following ? `Unfollow ${username}` : `Follow ${username}`
        }
        className={cn(
          buttonVariants({ variant: following ? "outline" : "default" }),
          "w-fit",
        )}
      >
        {following ? "Following" : "Follow"}
      </button>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

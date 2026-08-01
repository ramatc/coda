"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { followUser, unfollowUser } from "../../../lib/social";
import { useAsyncAction } from "../../../lib/use-async-action";

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
 *
 * Shares `useAsyncAction` with the four other write islands. That swap brought
 * one behaviour change here: the in-flight test is now a REF rather than the
 * `busy` state value, which both removes this file's `exhaustive-deps`
 * suppression and closes the same-tick re-entrancy window the like buttons
 * already guarded against.
 */
export function FollowButton({
  username,
  initialFollowing,
}: FollowButtonProps) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [following, setFollowing] = useState(initialFollowing);
  const { busy, error, running, run } = useAsyncAction();

  // Re-sync from fresh server props after this component's own
  // `router.refresh()` lands. Skipped while a request is in flight so it doesn't
  // stomp on an in-flight optimistic toggle. The guard reads a REF, so listing
  // it costs nothing and the dependency list is honest: this runs exactly when
  // the server prop changes, never the moment a toggle finishes.
  useEffect(() => {
    if (!running.current) {
      setFollowing(initialFollowing);
    }
  }, [initialFollowing, running]);

  async function toggle() {
    // Checked HERE as well as inside `run`, because the optimistic flip below
    // happens before the request starts: letting a rejected second click flip
    // local state would leave a change no request will ever settle.
    if (running.current) {
      return;
    }

    const previous = following;
    const next = !previous;

    // Optimistic flip: reflect the intended state immediately.
    setFollowing(next);

    await run(
      async () => {
        const token = await getToken();
        if (next) {
          await followUser(token, username);
        } else {
          await unfollowUser(token, username);
        }
        // The mutation already succeeded at this point, so a throwing
        // `router.refresh()` here must not escape into `run`'s outer catch:
        // `onError` below would unconditionally revert the optimistic toggle,
        // silently reverting a successful follow/unfollow even though the
        // server recorded it correctly.
        //
        // Server re-fetches the counts so the follower total updates in the same
        // view without a full reload.
        try {
          router.refresh();
        } catch (refreshFailure) {
          console.error(
            "FollowButton: router.refresh() threw after a successful follow/unfollow",
            refreshFailure,
          );
        }
      },
      {
        // Roll back the optimistic flip — the mutation did not persist.
        onError: () => {
          setFollowing(previous);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={following ? `Unfollow ${username}` : `Follow ${username}`}
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

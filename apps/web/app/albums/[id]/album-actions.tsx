"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import {
  MAX_RATING,
  MIN_RATING,
  deleteListen,
  deleteRating,
  markListened,
  rateAlbum,
  writeReview,
  type AlbumViewerState,
} from "../../../lib/albums";
import {
  markWantToListen,
  unmarkWantToListen,
} from "../../../lib/want-to-listen";
import { addListItem, type ListSummary } from "../../../lib/lists";

interface AlbumActionsProps {
  albumId: string;
  /** The viewer's current tracking state (server-fetched initial values). */
  viewer: AlbumViewerState;
  /**
   * The viewer's OWN lists (public and private), server-fetched, to populate
   * the "add to list" picker. Empty when the viewer has none — or when their
   * profile could not be resolved — in which case the picker gives way to a
   * hint pointing at the create-list page. Ownership here is per-LIST, not
   * per-album: any authenticated viewer may add any album to any of their own
   * lists, so this prop is never gated on who "owns" the album page.
   */
  ownLists: ListSummary[];
}

type Status = "idle" | "saving" | "error";

const RATING_OPTIONS = Array.from(
  { length: MAX_RATING - MIN_RATING + 1 },
  (_, i) => MIN_RATING + i,
);

/**
 * Album action island (client): mark listened, rate (1-10), write/edit a
 * plain-text review, and toggle the album on the viewer's want-to-listen
 * backlog — reflecting the viewer's current tracking state from the server.
 * After each mutation it calls `router.refresh()` so the server page re-fetches
 * and re-renders with the new aggregate + viewer state (same
 * server-authoritative pattern as the avatar-upload island). The review control
 * is gated on a present rating because the API subordinates a review to a
 * rating (a review on an unrated album is a 400).
 *
 * The want-to-listen control reads TWO independent viewer fields. `resolved`
 * (the album is already in this viewer's Listens OR Ratings) hides the control
 * outright — a backlog entry for an album you have already heard is meaningless,
 * and the API's read-time filter drops it anyway. Only when it is NOT resolved
 * does `wantToListenId` decide between the remove and add states. Hide
 * therefore wins over remove: resolving never deletes the row, so a resolved
 * album can still carry a surviving `wantToListenId`.
 */
export function AlbumActions({
  albumId,
  viewer,
  ownLists,
}: AlbumActionsProps) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  // The only action here whose success leaves NO visible trace on this page —
  // the album's own tracking state is unchanged by joining a list — so it says
  // so explicitly instead of snapping the picker back in silence.
  const [addedTo, setAddedTo] = useState<string | null>(null);
  const [reviewDraft, setReviewDraft] = useState(viewer.review ?? "");
  // Set right before `router.refresh()` (review save/update only, see `run`
  // below) and cleared only once the refreshed server props actually land —
  // detected by the effect below keyed on the `viewer` object identity, since
  // `router.refresh()` doesn't expose a completion callback. Without this,
  // the textarea re-enables immediately when the mutation promise resolves —
  // before the refetch lands — so keystrokes typed in that gap get silently
  // clobbered once the (now-stale) server value arrives (judgment-day PR9
  // round 3, finding #2).
  const [pendingRefresh, setPendingRefresh] = useState(false);

  // Re-syncs the draft from fresh server props (e.g. after `router.refresh()`
  // following a rating delete, which cascades to delete the review too — see
  // Decision #12). Without this, a stale draft could resurrect a review the
  // user believed was gone.
  useEffect(() => {
    setReviewDraft(viewer.review ?? "");
  }, [viewer.review]);

  // Marks a pending refresh as landed once the parent re-renders with a new
  // `viewer` prop object — the server component builds a fresh object on
  // every request, so its identity changes on every `router.refresh()`
  // regardless of whether `viewer.review`'s VALUE happens to differ (e.g.
  // re-saving the same text unchanged). Keying off identity here (rather than
  // reusing the effect above, which only reacts to a `review` value change)
  // avoids `pendingRefresh` getting stuck forever in that no-value-change case.
  useEffect(() => {
    setPendingRefresh(false);
  }, [viewer]);

  /**
   * Runs a mutation, then triggers `router.refresh()`. `affectsReviewDraft`
   * is set only by the review save/update action: it keeps the review
   * textarea disabled (via `pendingRefresh`) until the refreshed `viewer.review`
   * prop actually lands, closing the gap where the user could resume typing
   * before the refetch completes and have those keystrokes silently
   * overwritten once the (now-stale) server value arrives. The other actions
   * (listen, rating) have no locally-editable draft at risk, so they skip it.
   *
   * Returns whether the mutation succeeded, so a caller that owns extra
   * feedback (the list picker's confirmation) can react without duplicating
   * the try/catch — every other caller ignores it.
   */
  async function run(
    action: (token: string | null) => Promise<void>,
    affectsReviewDraft = false,
  ): Promise<boolean> {
    setStatus("saving");
    setError(null);
    // Any new action invalidates the previous confirmation, so a stale "Added
    // to X." can never sit next to an unrelated result.
    setAddedTo(null);
    try {
      const token = await getToken();
      await action(token);
      setStatus("idle");
      if (affectsReviewDraft) {
        setPendingRefresh(true);
      }
      router.refresh();
      return true;
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return false;
    }
  }

  /**
   * Adds this album to one of the viewer's own lists. The picker is a pure
   * trigger, never a selection: it is bound to the empty placeholder so it
   * snaps back after every choice, leaving the same list pickable again once
   * the confirmation or the API's duplicate-add 409 has been read.
   */
  async function addToList(listId: string) {
    const target = ownLists.find((list) => list.id === listId);
    const succeeded = await run(async (t) => {
      await addListItem(t, listId, albumId);
    });
    if (succeeded && target) {
      setAddedTo(target.title);
    }
  }

  const busy = status === "saving";
  // The review textarea/button additionally stay disabled through the
  // `pendingRefresh` gap described above — the other controls (listen,
  // rating) are single-action and have no locally-editable draft that a
  // stale refresh could clobber, so they only need `busy`.
  const reviewBusy = busy || pendingRefresh;

  return (
    <div className="flex flex-col gap-4 rounded-card border border-brand-100 p-4">
      <div className="flex flex-wrap items-center gap-3">
        {viewer.listened ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              viewer.listenId
                ? void run((t) => deleteListen(t, viewer.listenId as string))
                : undefined
            }
            className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
          >
            Listened ✓ — remove
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run((t) => markListened(t, albumId))}
            className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
          >
            Mark as listened
          </button>
        )}

        {viewer.resolved ? null : viewer.wantToListenId ? (
          <button
            type="button"
            disabled={busy}
            // Addressed by ALBUM id: the API scopes the delete to the caller's
            // own row for that album, so `wantToListenId` never reaches the URL.
            onClick={() => void run((t) => unmarkWantToListen(t, albumId))}
            className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
          >
            Want to listen ✓ — remove
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async (t) => {
                await markWantToListen(t, albumId);
              })
            }
            className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
          >
            + Want to listen
          </button>
        )}

        <label className="flex items-center gap-2 text-sm">
          <span className="opacity-70">Your rating</span>
          <select
            aria-label="Your rating"
            disabled={busy}
            value={viewer.score ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "") {
                void run((t) => deleteRating(t, albumId));
              } else {
                void run((t) => rateAlbum(t, albumId, Number(value)));
              }
            }}
            className="rounded-card border border-brand-200 px-3 py-2"
          >
            <option value="">—</option>
            {RATING_OPTIONS.map((score) => (
              <option key={score} value={score}>
                {score}
              </option>
            ))}
          </select>
        </label>

        {ownLists.length === 0 ? (
          // Shown rather than hidden: a viewer with no lists is exactly who
          // needs to hear that lists exist.
          <p className="text-sm opacity-70">
            You have no lists yet —{" "}
            <Link href="/lists/new" className="underline">
              create one
            </Link>
          </p>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <span className="opacity-70">Add to list</span>
            <select
              aria-label="Add to list"
              disabled={busy}
              // Always the placeholder: picking a list is an ACTION, not a
              // selection this control holds on to.
              value=""
              onChange={(e) => {
                const listId = e.target.value;
                if (listId !== "") {
                  void addToList(listId);
                }
              }}
              className="rounded-card border border-brand-200 px-3 py-2"
            >
              <option value="">Add to list…</option>
              {ownLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="review-body" className="text-sm opacity-70">
          Your review
        </label>
        <textarea
          id="review-body"
          value={reviewDraft}
          disabled={reviewBusy || viewer.score === null}
          onChange={(e) => setReviewDraft(e.target.value)}
          placeholder={
            viewer.score === null
              ? "Rate this album before writing a review."
              : "Write a plain-text review…"
          }
          rows={4}
          className="rounded-card border border-brand-200 px-3 py-2 text-sm"
        />
        <button
          type="button"
          disabled={reviewBusy || viewer.score === null || reviewDraft.trim() === ""}
          onClick={() =>
            void run((t) => writeReview(t, albumId, reviewDraft.trim()), true)
          }
          className={cn(buttonVariants({ variant: "default" }), "w-fit")}
        >
          {viewer.review ? "Update review" : "Save review"}
        </button>
      </div>

      {status === "error" && error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {addedTo ? (
        <p className="text-sm opacity-70" role="status">
          Added to {addedTo}.
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import {
  ReviewActionError,
  deleteComment,
  isBlankCommentBody,
  remainingCommentChars,
  updateComment,
  type ReviewComment,
} from "../../../lib/reviews";
import { useAsyncAction } from "../../../lib/use-async-action";

interface ReviewCommentItemProps {
  /** The parent review — both ids travel on every comment write. */
  reviewId: string;
  /** The comment this row is for, including its server-resolved `isOwn`. */
  comment: ReviewComment;
}

/** The irreversible-action prompt, mirroring `delete-list-button.tsx`. */
const DELETE_CONFIRM_MESSAGE = "Delete this comment? This cannot be undone.";

/**
 * Statuses that mean this row's picture of the world is STALE, so the server
 * page should be re-read after surfacing the error. Mirrors
 * `ReviewLikeButton`'s `RECONCILABLE_STATUSES`.
 *
 * - **404** — the comment (or its parent review) was deleted between render
 *   and the edit/delete request. Refreshing lets the SERVER PAGE drop the
 *   stale row instead of leaving dead controls on screen.
 * - **409** — included for parity with the like button's set, even though no
 *   comment-write path returns it today.
 *
 * A 5xx is excluded on purpose: nothing is known to have changed server-side,
 * so a refresh would just be a second failing round trip.
 */
const RECONCILABLE_STATUSES: ReadonlySet<number> = new Set([409, 404]);

/**
 * Author-only edit + delete controls for ONE comment row (client island).
 *
 * ## One island per row, not two
 *
 * Slice 2 split the equivalent list controls into `edit-list-form.tsx` and
 * `delete-list-button.tsx`, because those act on the PAGE's single subject. Here
 * both controls are row-scoped, so splitting would mount two islands per comment
 * and a review can carry an unbounded number of them (comments are not
 * paginated). Keeping them together halves that cost and keeps a row's two
 * mutually-exclusive states — reading and editing — in one place.
 *
 * Renders NOTHING at all for a comment the viewer does not own. `isOwn` is
 * resolved server-side against the viewer's local `User.id`, so it is
 * authoritative rather than a guess; the API independently answers 403 to a
 * non-author, so this is a UI affordance, never the access control itself.
 *
 * There is deliberately no anonymous branch: an anonymous viewer has `isOwn:
 * false` on every row, so they simply get no controls — a sign-in prompt per
 * comment would be noise, and the one on the comment FORM already offers the way
 * in.
 *
 * The editor re-seeds from props on every open, so a `router.refresh()` landing
 * while the row is closed is always reflected — there is no long-lived local
 * copy to go stale.
 */
export function ReviewCommentItem({
  reviewId,
  comment,
}: ReviewCommentItemProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  // The synchronous guard inside this hook matters on both actions: neither edit
  // nor delete is idempotent from the UI's point of view, and a second delete
  // would answer 404 on an already-gone row.
  const { busy, error, setError, running, run } = useAsyncAction();

  const remaining = remainingCommentChars(draft);
  const submittable = !busy && !isBlankCommentBody(draft) && remaining >= 0;

  /** Opens the editor on a draft freshly seeded from the current props. */
  function open() {
    setDraft(comment.body);
    setError(null);
    setEditing(true);
  }

  /** Collapses the editor, discarding the draft (the next open re-seeds it). */
  function cancel() {
    setEditing(false);
    setError(null);
  }

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!submittable) {
      return;
    }

    await run(
      async () => {
        await updateComment(
          await getToken(),
          reviewId,
          comment.id,
          draft.trim(),
        );
        setEditing(false);
        // The mutation already succeeded at this point, so a throwing
        // `router.refresh()` here must not escape into `run`'s outer catch:
        // `setEditing(false)` already committed, so that would misreport a
        // successful save as a failed mutation and render a false error
        // banner over an editor that already collapsed.
        //
        // The server page re-reads the comment list, so the row re-renders from
        // the saved value rather than from this island's draft. The API already
        // returned the updated comment; it is deliberately NOT re-fetched.
        try {
          router.refresh();
        } catch (refreshFailure) {
          console.error(
            "ReviewCommentItem: router.refresh() threw after a successful save",
            refreshFailure,
          );
        }
      },
      {
        // The editor stays OPEN with the draft intact — a 403/400 is something
        // the author can see and act on — so this handler only reconciles.
        onError: (caught) => {
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

  async function onDelete() {
    // The guard is read HERE too, ahead of `run`'s own, so a click arriving
    // mid-delete does not raise a second confirmation dialog it would then
    // silently discard.
    if (running.current || !window.confirm(DELETE_CONFIRM_MESSAGE)) {
      return;
    }

    await run(
      async () => {
        await deleteComment(await getToken(), reviewId, comment.id);
        // The mutation already succeeded at this point, so a throwing
        // `router.refresh()` here must not escape into `run`'s outer catch:
        // that would misreport a successful delete as a failed mutation, and
        // since the thrown value is not a `ReviewActionError`, `onError`'s
        // `reconcilable` check below would evaluate false and release the
        // latch on a comment that is actually already gone.
        try {
          router.refresh();
        } catch (refreshFailure) {
          console.error(
            "ReviewCommentItem: router.refresh() threw after a successful delete",
            refreshFailure,
          );
        }
      },
      {
        // Deliberately stays LATCHED, mirroring `delete-list-button.tsx`:
        // `router.refresh()` is fire-and-forget, so the row removal lands
        // asynchronously. Re-enabling Delete in that window would let a second
        // delete land on a comment that no longer exists.
        latchOnSuccess: true,
        onError: (caught) => {
          // Decided FIRST, before any side effect that could throw: the latch
          // decision must not depend on whether `router.refresh()` below
          // succeeds, or a throwing refresh would fall through to
          // `useAsyncAction`'s release path and silently defeat the
          // stay-latched protection this branch exists to provide.
          const reconcilable =
            caught instanceof ReviewActionError &&
            RECONCILABLE_STATUSES.has(caught.status);

          if (reconcilable) {
            // The server has already confirmed this comment (or its parent
            // review) is gone — that is not a transient failure, so the control
            // stays latched exactly like the success path. Re-enabling Delete
            // here would reopen the same ghost-row window: a second click
            // landing on a row that `router.refresh()` is about to remove.
            try {
              router.refresh();
            } catch (refreshFailure) {
              // The latch decision above is already final — a throwing
              // refresh must not retroactively turn a confirmed-terminal
              // delete into a released control. Logged (not swallowed
              // silently), or a row stuck "Deleting…" leaves zero trace of
              // why.
              console.error(
                "ReviewCommentItem: router.refresh() threw while reconciling a delete failure",
                refreshFailure,
              );
            }
          }

          // A genuinely transient failure (400/403/500/network) did not persist,
          // so returning `false` re-enables the control for a retry.
          return reconcilable;
        },
      },
    );
  }

  if (!comment.isOwn) {
    return null;
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={open}
            disabled={busy}
            aria-label="Edit comment"
            className="text-xs underline opacity-70"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={busy}
            aria-label="Delete comment"
            className="text-xs text-red-600 underline"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
        {error ? (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => void onSave(event)}
      className="flex flex-col gap-2"
    >
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <label htmlFor={`edit-comment-${comment.id}`} className="sr-only">
        Edit comment
      </label>
      <textarea
        id={`edit-comment-${comment.id}`}
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        className="rounded-card border border-brand-200 px-3 py-2 text-sm"
      />

      <div className="flex items-center gap-3">
        <p
          data-testid="edit-comment-remaining"
          className={cn(
            "text-xs opacity-60",
            remaining < 0 && "text-red-600 opacity-100",
          )}
        >
          {remaining} characters left
        </p>
        <button
          type="submit"
          disabled={!submittable}
          aria-label="Save comment"
          className={cn(
            buttonVariants(),
            "w-fit",
            !submittable && "pointer-events-none opacity-50",
          )}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

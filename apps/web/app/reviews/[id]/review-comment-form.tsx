"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import {
  ReviewActionError,
  createComment,
  isBlankCommentBody,
  remainingCommentChars,
} from "../../../lib/reviews";
import { ReviewSignInPrompt } from "./review-sign-in-prompt";

interface ReviewCommentFormProps {
  /** The review being commented on (path param for the API call). */
  reviewId: string;
  /** `false` for an anonymous, bad-token, or not-yet-synced viewer. */
  canInteract: boolean;
}

/**
 * Statuses that mean this island's picture of the world is STALE, so the
 * server page should be re-read after surfacing the error. Mirrors
 * `ReviewLikeButton`'s `RECONCILABLE_STATUSES`.
 *
 * - **404** — the parent review was deleted between render and submit.
 *   Refreshing lets the SERVER PAGE surface the not-found state.
 * - **409** — included for parity with the like button's set, even though no
 *   comment-write path returns it today.
 *
 * A 5xx is excluded on purpose: nothing is known to have changed server-side,
 * so a refresh would just be a second failing round trip.
 */
const RECONCILABLE_STATUSES: ReadonlySet<number> = new Set([409, 404]);

/**
 * Add-a-comment island for a review (client).
 *
 * The new comment is NOT inserted locally on success — the draft is cleared and
 * `router.refresh()` lets the server page re-read the list. Comments come back
 * ordered `createdAt asc, id asc` with each row's `isOwn` resolved server-side,
 * and neither of those is something this island could synthesize correctly for a
 * locally-appended row.
 *
 * Submit stays disabled until the draft is genuinely postable, so the API's
 * empty-body and over-length 400s are unreachable rather than merely handled.
 * Emptiness is decided by {@link isBlankCommentBody}, which strips zero-width
 * characters exactly as the API does — a bare `.trim()` would let a
 * visually-blank paste through. When the request DOES fail the API's own message
 * is surfaced inline and the draft is KEPT, so a validation answer is something
 * the viewer can act on rather than retype.
 *
 * When `canInteract` is false the island renders a sign-in prompt instead of the
 * form, owning its anonymous branch exactly as the like island does.
 */
export function ReviewCommentForm({
  reviewId,
  canInteract,
}: ReviewCommentFormProps) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Synchronous guard: comment creation has no idempotency key, so two clicks
  // landing in the same tick would post the comment twice.
  const inFlight = useRef(false);

  const remaining = remainingCommentChars(draft);
  const submittable = !saving && !isBlankCommentBody(draft) && remaining >= 0;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!submittable || inFlight.current) {
      return;
    }

    inFlight.current = true;
    setSaving(true);
    setError(null);

    try {
      // Trimmed exactly as the API stores it, so the posted row and the draft
      // never disagree about leading/trailing space.
      await createComment(await getToken(), reviewId, draft.trim());
      setDraft("");
      router.refresh();
    } catch (err) {
      // The draft deliberately SURVIVES a failure — a validation 400 is the
      // viewer's to correct, and clearing it would force a retype.
      setError(err instanceof Error ? err.message : "Something went wrong.");

      if (
        err instanceof ReviewActionError &&
        RECONCILABLE_STATUSES.has(err.status)
      ) {
        router.refresh();
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  if (!canInteract) {
    return (
      <ReviewSignInPrompt reviewId={reviewId} label="Sign in to comment" />
    );
  }

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className="flex flex-col gap-3 rounded-card border border-brand-100 p-4"
    >
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <label htmlFor="review-comment-body" className="text-sm opacity-70">
        Add a comment
      </label>
      <textarea
        id="review-comment-body"
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What did you make of this review?"
        rows={3}
        className="rounded-card border border-brand-200 px-3 py-2 text-sm"
      />

      <div className="flex items-center justify-between gap-3">
        <p
          data-testid="comment-remaining"
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
          className={cn(
            buttonVariants(),
            "w-fit",
            !submittable && "pointer-events-none opacity-50",
          )}
        >
          {saving ? "Posting…" : "Post comment"}
        </button>
      </div>
    </form>
  );
}

"use client";

import { reviewPath } from "../../../lib/reviews";
import { SignInPrompt } from "../../_shell/sign-in-prompt";

interface ReviewSignInPromptProps {
  /** The review being read — the visitor is returned here after signing in. */
  reviewId: string;
  /** What this particular prompt offers, e.g. `"Sign in to like"`. */
  label: string;
}

/**
 * The shared anonymous branch for the review islands: what a visitor sees in
 * place of a live control when `viewer.canInteract` is false. A thin binding of
 * {@link SignInPrompt} to this review's path, so every review island returns
 * the visitor to the same place.
 *
 * Note that `review-comment-item.tsx` deliberately does NOT use it: that island
 * renders only for a viewer's OWN comments, which an anonymous visitor can
 * never have.
 */
export function ReviewSignInPrompt({
  reviewId,
  label,
}: ReviewSignInPromptProps) {
  return <SignInPrompt returnTo={reviewPath(reviewId)} label={label} />;
}

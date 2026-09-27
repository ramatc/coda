"use client";

import { SignInButton } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";
import { reviewPath } from "../../../lib/reviews";

interface ReviewSignInPromptProps {
  /** The review being read — the visitor is returned here after signing in. */
  reviewId: string;
  /** What this particular prompt offers, e.g. `"Sign in to like"`. */
  label: string;
}

/**
 * The shared anonymous branch for the review islands: what a visitor sees in
 * place of a live control when `viewer.canInteract` is false.
 *
 * ## Why this is the app's FIRST Clerk UI component
 *
 * `/reviews/[id]` is the app's only anonymously-readable page, so it is also the
 * first place that ever needed to offer a signed-out visitor a way in — every
 * other route simply bounces through `auth.protect()` on the in-app
 * `/sign-in` route (see `app/sign-in/[[...sign-in]]/page.tsx`), which never
 * has to render an invitation. `SignInButton` is used here instead of a plain
 * link to `/sign-in` so this prompt can carry `forceRedirectUrl` itself,
 * rather than relying on Clerk's generic `redirect_url` query-param
 * convention.
 *
 * `forceRedirectUrl` is the load-bearing prop: it returns the visitor to the
 * review that prompted them, instead of Clerk's default destination. Redirect
 * mode (the default) is deliberate over `mode="modal"` — a modal would leave the
 * viewer on a page whose SERVER-rendered `viewer.canInteract` is still false, so
 * every control would stay dead until a manual reload. A full round trip
 * re-renders the page with a resolved viewer.
 *
 * Kept as ONE shared component rather than inlined per island so the sign-in
 * journey is decided, tested, and mocked in exactly one place. Note that
 * `review-comment-item.tsx` deliberately does NOT use it: that island renders
 * only for a viewer's OWN comments, which an anonymous visitor can never have.
 */
export function ReviewSignInPrompt({
  reviewId,
  label,
}: ReviewSignInPromptProps) {
  return (
    <SignInButton mode="redirect" forceRedirectUrl={reviewPath(reviewId)}>
      <button
        type="button"
        className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
      >
        {label}
      </button>
    </SignInButton>
  );
}

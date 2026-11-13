"use client";

import { SignInButton } from "@clerk/nextjs";
import { buttonVariants, cn } from "@coda/ui";

interface SignInPromptProps {
  /** The page the visitor is returned to after signing in. */
  returnTo: string;
  /** What this particular prompt offers, e.g. `"Sign in to like"`. */
  label: string;
}

/**
 * What an anonymous visitor sees in place of a live control on a public page
 * (`/reviews/[id]`, `/albums/[id]`, `/lists/[id]`).
 *
 * `SignInButton` is used instead of a plain link to `/sign-in` so the prompt
 * can carry `forceRedirectUrl` itself: it returns the visitor to the page that
 * prompted them rather than Clerk's default destination. Redirect mode (the
 * default) is deliberate over `mode="modal"` — a modal would leave the visitor
 * on a page whose SERVER-rendered viewer state is still anonymous, so every
 * control would stay dead until a manual reload. A full round trip re-renders
 * the page with a resolved viewer.
 *
 * Kept as ONE shared component so the sign-in journey is decided, tested, and
 * mocked in exactly one place.
 */
export function SignInPrompt({ returnTo, label }: SignInPromptProps) {
  return (
    <SignInButton mode="redirect" forceRedirectUrl={returnTo}>
      <button
        type="button"
        className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
      >
        {label}
      </button>
    </SignInButton>
  );
}

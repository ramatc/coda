import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { REVIEW_NOT_FOUND, fetchReview } from "../../../lib/reviews";
import { ReviewDetailView } from "./review-detail";

interface ReviewPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Review detail page at `/reviews/[id]` (server component) — the app's FIRST
 * anonymously-readable route. Two deliberate omissions make that work, and
 * neither may be "fixed" back into line with the other detail pages:
 *
 * 1. **No entry in `protectedRoutePatterns`** (`middleware.config.ts`). Unlisted
 *    routes are public by default; adding `/reviews(.*)` would send every
 *    logged-out visitor to sign-in. `middleware-config.test.ts` asserts its
 *    absence so a careless addition fails a test.
 * 2. **No onboarding gate.** `/albums/[id]`, `/lists/[id]` and `/u/[username]`
 *    all call `fetchOnboardingStatus` + `resolveOnboardingRedirect` first. This
 *    page must not: the gate would bounce an anonymous visitor to `/onboarding`.
 *
 * `auth()` still runs, because a token is what lets the API resolve a SIGNED-IN
 * viewer (`viewer.canInteract`, `hasLiked`, per-comment `isOwn`). It simply
 * yields `null` for a logged-out visitor, and `fetchReview` then omits the
 * Authorization header entirely rather than sending a blank bearer.
 *
 * A 404 covers an unknown review and one deleted between link and click alike,
 * so `notFound()` is the whole not-found story. The like/comment islands are not
 * wired yet — this slice ships the read path; `ReviewDetailView`'s slots stay
 * empty until they land.
 */
export default async function ReviewPage({ params }: ReviewPageProps) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken();

  const review = await fetchReview(token, id);
  if (review === REVIEW_NOT_FOUND) {
    notFound();
  }

  return <ReviewDetailView review={review} />;
}

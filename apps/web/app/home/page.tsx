import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { fetchRecommendations } from "../../lib/recommendations";
import { Recommendations } from "./recommendations";

/**
 * Home page at `/home` (server component), protected by the Clerk middleware and
 * onboarding-gated: a signed-in user who has NOT completed onboarding is
 * redirected to `/onboarding` before any home content renders.
 *
 * PR11 fills `/home` with the user's heuristic recommendations (genre/artist
 * overlap + popularity, precomputed into `Recommendation` rows) surfaced via the
 * dismiss-capable {@link Recommendations} island. Per the spec's `/home` scope,
 * this surfaces recommendations only — the user's own activity lives at
 * `/activity`. A lightweight nav links out to discover and activity (the shared
 * app-shell nav across every page is a known follow-up — see the apply notes).
 */
export default async function HomePage() {
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/home");
  if (redirectTo) {
    redirect(redirectTo);
  }

  const recommendations = await fetchRecommendations(token);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold text-brand-600">Your Coda</h1>
        <nav className="flex gap-4 text-sm font-medium">
          <Link href="/search" className="text-brand-600 hover:underline">
            Discover
          </Link>
          <Link href="/activity" className="text-brand-600 hover:underline">
            Your activity
          </Link>
        </nav>
      </header>

      <section aria-label="Recommended for you" className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">
          Recommended for you
        </h2>
        <Recommendations items={recommendations} />
      </section>
    </main>
  );
}

import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";

/**
 * Home page at `/home` (server component), protected by the Clerk middleware.
 * Enforces the onboarding gate: a signed-in user who has NOT completed
 * onboarding is redirected to `/onboarding` before any home content renders.
 *
 * Fase 1 PR4 ships only the gate + a placeholder shell — PR11 fills `/home`
 * with real recommendations/highlights.
 */
export default async function HomePage() {
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/home");
  if (redirectTo) {
    redirect(redirectTo);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold text-brand-600">Your Coda</h1>
      <p className="text-base opacity-70">
        Recommendations land here soon. Onboarding is complete.
      </p>
    </main>
  );
}

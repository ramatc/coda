import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchGenres,
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { OnboardingWizard } from "./onboarding-wizard";

/**
 * Onboarding page at `/onboarding` (server component). Protected by the Clerk
 * middleware, so a session always exists here. If the user has ALREADY completed
 * onboarding the gate bounces them to `/home`; otherwise it pre-fetches the
 * fixed genre taxonomy and renders the client wizard.
 */
export default async function OnboardingPage() {
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, "/onboarding");
  if (redirectTo) {
    redirect(redirectTo);
  }

  const genres = await fetchGenres(token);
  return <OnboardingWizard genres={genres} />;
}

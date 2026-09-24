import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import {
  fetchGenres,
  fetchOnboardingStatus,
  resolveOnboardingRedirect,
} from "../../lib/onboarding";
import { fetchPopularAlbums } from "../../lib/search";
import { OnboardingWizard } from "./onboarding-wizard";

/** Real popular albums shown in the editorial panel's record collage — purely
 * editorial dressing, never mocked. */
const SPOTLIGHT_ALBUM_COUNT = 3;

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

  const [genres, popularAlbums] = await Promise.all([
    fetchGenres(token),
    fetchPopularAlbums(token),
  ]);
  return (
    <OnboardingWizard
      genres={genres}
      spotlightAlbums={popularAlbums.slice(0, SPOTLIGHT_ALBUM_COUNT)}
    />
  );
}

import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getApiBaseUrl } from "../../../lib/api-client";
import { fetchOnboardingStatus, resolveOnboardingRedirect } from "../../../lib/onboarding";
import { fetchSocialStats } from "../../../lib/social";
import { ProfileView, type ProfileDto } from "./profile-view";
import { AvatarUpload } from "./avatar-upload";
import { FollowButton } from "./follow-button";

interface PublicProfileDto extends ProfileDto {
  isOwnProfile: boolean;
}

interface ProfilePageProps {
  params: Promise<{ username: string }>;
}

/**
 * Public profile page at `/u/[username]` (server component). Fetches the
 * profile from the API with the viewer's Clerk token, then renders the pure
 * {@link ProfileView}. The avatar-upload island is composed in only when the
 * viewer is the profile owner.
 */
export default async function ProfilePage({ params }: ProfilePageProps) {
  const { username } = await params;
  const { getToken } = await auth();
  const token = await getToken();

  const status = await fetchOnboardingStatus(token);
  const redirectTo = resolveOnboardingRedirect(status, `/u/${username}`);
  if (redirectTo) {
    redirect(redirectTo);
  }

  // Fetch the profile and social stats in parallel — one round-trip latency
  // instead of two. `fetchSocialStats` fails safe to zero-counts, so a stats
  // hiccup never blocks the profile render; the profile fetch alone drives the
  // 404/error control flow below.
  const [response, stats] = await Promise.all([
    fetch(`${getApiBaseUrl()}/profile/${encodeURIComponent(username)}`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      cache: "no-store",
    }),
    fetchSocialStats(token, username),
  ]);

  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    throw new Error(`Failed to load profile (${response.status})`);
  }

  const profile = (await response.json()) as PublicProfileDto;
  const isOwnProfile = profile.isOwnProfile;

  return (
    <ProfileView
      profile={profile}
      isOwnProfile={isOwnProfile}
      stats={stats}
      followButton={
        <FollowButton
          username={profile.username}
          initialFollowing={stats.isFollowing}
        />
      }
    >
      <AvatarUpload />
    </ProfileView>
  );
}

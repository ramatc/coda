import { notFound, redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getApiBaseUrl } from "../../../lib/api-client";
import { fetchOnboardingStatus, resolveOnboardingRedirect } from "../../../lib/onboarding";
import { fetchSocialStats } from "../../../lib/social";
import { fetchUserLists } from "../../../lib/lists";
import { fetchWantToListen } from "../../../lib/want-to-listen";
import { ProfileView, type ProfileDto } from "./profile-view";
import { AvatarUpload } from "./avatar-upload";
import { FollowButton } from "./follow-button";
import { ListsSection } from "./lists-section";
import { WantToListenSection } from "./want-to-listen-section";

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
 *
 * Slice 2 adds two content sections, composed here and handed to the view as
 * slots so the view stays free of data-fetching: the profile's Lists and their
 * want-to-listen backlog. Both are additive — the slice-1 header, counts,
 * follow button and bio are untouched.
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

  // Fetch the profile, social stats, lists and want-to-listen backlog in
  // parallel — one round-trip latency instead of four. All three companions
  // fail safe (zero-counts, empty lists, empty backlog), so a hiccup in any of
  // them degrades one section instead of blocking the page; the profile fetch
  // alone drives the 404/error control flow below.
  //
  // Both slice-2 endpoints are keyed by the PROFILE's username and apply their
  // own visibility rules server-side: `GET /users/:username/lists` returns every
  // list to its owner and only public ones to anyone else, so this page never
  // filters, and the want-to-listen payload arrives already auto-resolved.
  const [response, stats, lists, wantToListen] = await Promise.all([
    fetch(`${getApiBaseUrl()}/profile/${encodeURIComponent(username)}`, {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      cache: "no-store",
    }),
    fetchSocialStats(token, username),
    fetchUserLists(token, username),
    fetchWantToListen(token, username),
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
      listsSection={
        <ListsSection lists={lists} isOwnProfile={isOwnProfile} />
      }
      wantToListenSection={
        <WantToListenSection
          entries={wantToListen}
          isOwnProfile={isOwnProfile}
        />
      }
    >
      <AvatarUpload />
    </ProfileView>
  );
}

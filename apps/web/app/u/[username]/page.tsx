import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getApiBaseUrl } from "../../../lib/api-client";
import { ProfileView, type ProfileDto } from "./profile-view";
import { AvatarUpload } from "./avatar-upload";

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

  const response = await fetch(
    `${getApiBaseUrl()}/profile/${encodeURIComponent(username)}`,
    {
      headers: { Authorization: `Bearer ${token ?? ""}` },
      cache: "no-store",
    },
  );

  if (response.status === 404) {
    notFound();
  }
  if (!response.ok) {
    throw new Error(`Failed to load profile (${response.status})`);
  }

  const profile = (await response.json()) as PublicProfileDto;
  const isOwnProfile = profile.isOwnProfile;

  return (
    <ProfileView profile={profile} isOwnProfile={isOwnProfile}>
      <AvatarUpload />
    </ProfileView>
  );
}

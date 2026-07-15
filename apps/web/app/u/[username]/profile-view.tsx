import type { ReactNode } from "react";

/** Public shape of a profile as returned by the API's `/profile/:username`. */
export interface ProfileDto {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  isPrivate: boolean;
}

/**
 * Follower/following counts (and the viewer's follow state) surfaced on the
 * profile. Structurally mirrors the API's `/users/:username/social` payload;
 * kept as a local shape so the presentational view stays decoupled from the
 * `lib/social` fetch layer (the page passes it down).
 */
export interface ProfileSocialStats {
  followerCount: number;
  followingCount: number;
  isFollowing: boolean;
}

interface ProfileViewProps {
  profile: ProfileDto;
  isOwnProfile: boolean;
  /** Follower/following counts rendered under the profile header. */
  stats: ProfileSocialStats;
  /** The avatar-upload island, rendered only for the profile owner. */
  children?: ReactNode;
  /**
   * The follow-button island. Rendered only when viewing ANOTHER user's
   * profile — never on the owner's own profile (no self-follow affordance).
   */
  followButton?: ReactNode;
}

/**
 * Presentational profile card (container/presentational split): a pure,
 * synchronous component with no data-fetching or auth concerns, so it renders
 * in a plain unit test. The async server page fetches the data and composes
 * this with the owner-only upload island and the visitor-only follow button.
 */
export function ProfileView({
  profile,
  isOwnProfile,
  stats,
  children,
  followButton,
}: ProfileViewProps) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center gap-4">
        {profile.avatarUrl ? (
          // Avatar is a remote R2 URL rendered with a plain <img>; next/image
          // remote-pattern config is deferred to a later slice.
          <img
            src={profile.avatarUrl}
            alt={`${profile.displayName}'s avatar`}
            width={80}
            height={80}
            className="h-20 w-20 rounded-full object-cover"
            data-testid="avatar-image"
          />
        ) : (
          <div
            className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-100 text-2xl font-semibold text-brand-700"
            data-testid="avatar-placeholder"
          >
            {profile.displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <div>
            <h1 className="text-2xl font-semibold">{profile.displayName}</h1>
            <p className="text-sm opacity-70">@{profile.username}</p>
          </div>
          <div className="flex gap-4 text-sm">
            <span data-testid="follower-count">
              <strong>{stats.followerCount}</strong> followers
            </span>
            <span data-testid="following-count">
              <strong>{stats.followingCount}</strong> following
            </span>
          </div>
        </div>
      </header>

      {!isOwnProfile ? followButton : null}

      {profile.bio ? (
        <p className="whitespace-pre-line text-base">{profile.bio}</p>
      ) : (
        <p className="text-sm italic opacity-50">No bio yet.</p>
      )}

      {isOwnProfile ? <section aria-label="Edit avatar">{children}</section> : null}
    </main>
  );
}

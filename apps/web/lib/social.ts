import { getApiBaseUrl } from "./api-client";

/** Social-graph counts for a profile plus the caller's own follow state. */
export interface SocialStats {
  /** How many users follow this profile. */
  followerCount: number;
  /** How many users this profile follows. */
  followingCount: number;
  /** Whether the authenticated viewer currently follows this profile. */
  isFollowing: boolean;
}

/**
 * Zero-state stats used when the social endpoint fails or the viewer is not yet
 * synced. The profile still renders (counts show 0, no follow state) rather than
 * throwing during render — same fail-safe posture as `fetchRecommendations`.
 */
const EMPTY_STATS: SocialStats = {
  followerCount: 0,
  followingCount: 0,
  isFollowing: false,
};

/**
 * Fetches follower/following counts (and the viewer's follow state) for a
 * profile, server-side, with the viewer's Clerk token. A network failure or
 * non-OK response fails safe to {@link EMPTY_STATS} instead of throwing during
 * render — the profile page still renders its shell, and counts fill in on the
 * next visit. Mirrors the `fetchRecommendations` degrade-to-empty posture.
 */
export async function fetchSocialStats(
  token: string | null,
  username: string,
): Promise<SocialStats> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/users/${encodeURIComponent(username)}/social`,
      {
        headers: { Authorization: `Bearer ${token ?? ""}` },
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return EMPTY_STATS;
    }
    return (await response.json()) as SocialStats;
  } catch {
    return EMPTY_STATS;
  }
}

/**
 * Follows `username` on behalf of the viewer (the follow-button island). Throws
 * on a non-OK response so the island can surface an error and roll back its
 * optimistic flip. `POST /users/:username/follow` is idempotent server-side
 * (re-following an already-followed user is a no-op success).
 */
export async function followUser(
  token: string | null,
  username: string,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/users/${encodeURIComponent(username)}/follow`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token ?? ""}` },
    },
  );
  if (!response.ok) {
    throw new Error("Could not follow this user.");
  }
}

/**
 * Unfollows `username` on behalf of the viewer. Throws on a non-OK response so
 * the island can surface an error and roll back its optimistic flip.
 * `DELETE /users/:username/follow` is idempotent server-side (unfollowing a user
 * you do not follow is a no-op success).
 */
export async function unfollowUser(
  token: string | null,
  username: string,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/users/${encodeURIComponent(username)}/follow`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token ?? ""}` },
    },
  );
  if (!response.ok) {
    throw new Error("Could not unfollow this user.");
  }
}

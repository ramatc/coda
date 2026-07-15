import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProfileView,
  type ProfileDto,
  type ProfileSocialStats,
} from "../app/u/[username]/profile-view";

/**
 * Smoke tests for the presentational profile card. Being a pure, synchronous
 * component (the container/presentational split keeps data-fetching + Clerk out
 * of it), it renders to static HTML without a request context — the same
 * pattern as the Fase 0 home-page test.
 */
const baseProfile: ProfileDto = {
  userId: "local_1",
  username: "ada",
  displayName: "Ada Lovelace",
  bio: "Analytical Engine enthusiast",
  avatarUrl: "https://cdn.coda.test/avatars/avatars/local_1/x.png",
  isPrivate: false,
};

const baseStats: ProfileSocialStats = {
  followerCount: 0,
  followingCount: 0,
  isFollowing: false,
};

describe("ProfileView", () => {
  it("renders the username, display name, bio and avatar", () => {
    const html = renderToStaticMarkup(
      <ProfileView
        profile={baseProfile}
        isOwnProfile={false}
        stats={baseStats}
      />,
    );

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("@ada");
    expect(html).toContain("Analytical Engine enthusiast");
    expect(html).toContain(baseProfile.avatarUrl as string);
  });

  it("falls back to an initial placeholder when there is no avatar", () => {
    const html = renderToStaticMarkup(
      <ProfileView
        profile={{ ...baseProfile, avatarUrl: null }}
        isOwnProfile={false}
        stats={baseStats}
      />,
    );

    expect(html).toContain("avatar-placeholder");
    expect(html).not.toContain("avatar-image");
  });

  it("renders the owner-only upload island only for the profile owner", () => {
    const ownerHtml = renderToStaticMarkup(
      <ProfileView profile={baseProfile} isOwnProfile stats={baseStats}>
        <button>upload-island</button>
      </ProfileView>,
    );
    expect(ownerHtml).toContain("upload-island");

    const visitorHtml = renderToStaticMarkup(
      <ProfileView
        profile={baseProfile}
        isOwnProfile={false}
        stats={baseStats}
      >
        <button>upload-island</button>
      </ProfileView>,
    );
    expect(visitorHtml).not.toContain("upload-island");
  });

  it("renders follower and following counts from the stats", () => {
    const html = renderToStaticMarkup(
      <ProfileView
        profile={baseProfile}
        isOwnProfile={false}
        stats={{ followerCount: 3, followingCount: 5, isFollowing: false }}
      />,
    );

    expect(html).toContain("<strong>3</strong> followers");
    expect(html).toContain("<strong>5</strong> following");
  });

  it("renders the follow-button slot only when viewing another user's profile", () => {
    const visitorHtml = renderToStaticMarkup(
      <ProfileView
        profile={baseProfile}
        isOwnProfile={false}
        stats={baseStats}
        followButton={<button>follow-island</button>}
      />,
    );
    expect(visitorHtml).toContain("follow-island");

    const ownerHtml = renderToStaticMarkup(
      <ProfileView
        profile={baseProfile}
        isOwnProfile
        stats={baseStats}
        followButton={<button>follow-island</button>}
      />,
    );
    expect(ownerHtml).not.toContain("follow-island");
  });

  it("still shows counts on the owner's own profile even though the follow button is hidden", () => {
    const html = renderToStaticMarkup(
      <ProfileView
        profile={baseProfile}
        isOwnProfile
        stats={{ followerCount: 2, followingCount: 4, isFollowing: false }}
        followButton={<button>follow-island</button>}
      />,
    );

    expect(html).toContain("<strong>2</strong> followers");
    expect(html).toContain("<strong>4</strong> following");
    expect(html).not.toContain("follow-island");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProfileView,
  type ProfileDto,
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

describe("ProfileView", () => {
  it("renders the username, display name, bio and avatar", () => {
    const html = renderToStaticMarkup(
      <ProfileView profile={baseProfile} isOwnProfile={false} />,
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
      />,
    );

    expect(html).toContain("avatar-placeholder");
    expect(html).not.toContain("avatar-image");
  });

  it("renders the owner-only upload island only for the profile owner", () => {
    const ownerHtml = renderToStaticMarkup(
      <ProfileView profile={baseProfile} isOwnProfile>
        <button>upload-island</button>
      </ProfileView>,
    );
    expect(ownerHtml).toContain("upload-island");

    const visitorHtml = renderToStaticMarkup(
      <ProfileView profile={baseProfile} isOwnProfile={false}>
        <button>upload-island</button>
      </ProfileView>,
    );
    expect(visitorHtml).not.toContain("upload-island");
  });
});

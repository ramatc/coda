// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  ProfileView,
  type ProfileDto,
  type ProfileSocialStats,
} from "../app/u/[username]/profile-view";
import { ListsSection } from "../app/u/[username]/lists-section";
import { WantToListenSection } from "../app/u/[username]/want-to-listen-section";
import type { ListSummary } from "../lib/lists";
import type { WantToListenEntry } from "../lib/want-to-listen";

// The composition tests below mount the REAL profile sections, one of which is
// a client island. These three mocks are what it needs to render outside a Next
// request context — the view itself uses none of them.
// Every prop other than `href` is forwarded rather than dropped, so
// `data-testid` and friends survive into the DOM — without that, a
// `getByTestId` on a link silently fails and a `not.toContain(testid)`
// assertion passes for the wrong reason.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

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

  it("renders the lists and want-to-listen slots on every profile, owner or visitor", () => {
    // Neither section is owner-gated: the spec requires both to exist for every
    // user, so the view hands them through unconditionally and each section
    // decides for itself what a visitor may act on.
    for (const isOwnProfile of [true, false]) {
      const html = renderToStaticMarkup(
        <ProfileView
          profile={baseProfile}
          isOwnProfile={isOwnProfile}
          stats={baseStats}
          listsSection={<p>lists-section</p>}
          wantToListenSection={<p>want-to-listen-section</p>}
        />,
      );

      expect(html).toContain("lists-section");
      expect(html).toContain("want-to-listen-section");
      // Lists first, backlog second — the order the spec names them in.
      expect(html.indexOf("lists-section")).toBeLessThan(
        html.indexOf("want-to-listen-section"),
      );
    }
  });
});

/** One list summary for the composed-profile tests. */
const LISTS: ListSummary[] = [
  {
    id: "l1",
    title: "Best of 2026",
    description: null,
    isRanked: true,
    isPublic: true,
    itemCount: 2,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  },
];

/** One backlog entry for the composed-profile tests. */
const BACKLOG: WantToListenEntry[] = [
  {
    id: "w1",
    albumId: "album-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    album: {
      id: "album-1",
      title: "Kid A",
      coverUrl: null,
      primaryArtistName: "Radiohead",
    },
  },
];

/**
 * Composition tests: the real sections mounted into the real view, which is the
 * only place the spec's "two distinct sections, additive to slice 1" claim can
 * actually be checked. The server page's own job — fetching the two payloads in
 * parallel — is the same two-line composition the album page does and has no
 * test precedent in this repo.
 */
describe("ProfileView composed with both slice-2 sections", () => {
  function renderProfile(entries: WantToListenEntry[], lists: ListSummary[]) {
    return render(
      <ProfileView
        profile={baseProfile}
        isOwnProfile={false}
        stats={{ followerCount: 3, followingCount: 5, isFollowing: false }}
        followButton={<button>Follow</button>}
        listsSection={<ListsSection lists={lists} isOwnProfile={false} />}
        wantToListenSection={
          <WantToListenSection entries={entries} isOwnProfile={false} />
        }
      />,
    );
  }

  it("renders Lists and Want to listen as two distinct, independently populated regions", () => {
    renderProfile(BACKLOG, LISTS);

    const lists = screen.getByRole("region", { name: "Lists" });
    const backlog = screen.getByRole("region", { name: "Want to listen" });

    expect(lists).not.toBe(backlog);
    expect(lists.contains(backlog)).toBe(false);
    // Each section holds only its own rows — no bleed between them.
    expect(within(lists).getByRole("link", { name: "Best of 2026" })).not.toBeNull();
    expect(within(lists).queryByText("Kid A")).toBeNull();
    expect(within(backlog).getByRole("link", { name: "Kid A" })).not.toBeNull();
    expect(within(backlog).queryByText("Best of 2026")).toBeNull();
  });

  it("keeps the slice-1 profile content intact alongside the new sections", () => {
    renderProfile(BACKLOG, LISTS);

    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).not.toBeNull();
    expect(screen.getByText("Analytical Engine enthusiast")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Follow" })).not.toBeNull();
    expect(screen.getByTestId("follower-count").textContent).toBe("3 followers");
  });

  it("still renders both sections, each with its own empty state, on an empty profile", () => {
    renderProfile([], []);

    const lists = screen.getByRole("region", { name: "Lists" });
    const backlog = screen.getByRole("region", { name: "Want to listen" });

    expect(within(lists).getByText("No public lists yet.")).not.toBeNull();
    expect(
      within(backlog).getByText("Nothing on the want-to-listen list yet."),
    ).not.toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

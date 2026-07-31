// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { FeedList } from "../app/feed/feed-list";
import type { FeedItem } from "../lib/feed";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same spirit as the activity-feed test). The remaining props
// are forwarded rather than dropped so `data-testid` survives into the DOM —
// without that, a `getByTestId` on a link silently fails and a
// `not.toContain(testid)` assertion passes for the wrong reason.
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

afterEach(() => {
  cleanup();
});

const album = {
  id: "album-1",
  title: "OK Computer",
  coverUrl: null,
  primaryArtistName: "Radiohead",
};

const thom = { username: "thom", displayName: "Thom Yorke", avatarUrl: null };
const jonny = {
  username: "jonny",
  displayName: "Jonny Greenwood",
  avatarUrl: null,
};

/**
 * The review triple for an event that has no review to link to: a LISTEN or
 * RATING event, or a stranded REVIEW event whose `Review` row was deleted. All
 * three fields degrade together — `null` means "no review", which is distinct
 * from a live review with a count of `0`.
 */
const NO_REVIEW = {
  reviewId: null,
  reviewLikeCount: null,
  reviewCommentCount: null,
} as const;

const items: FeedItem[] = [
  {
    id: "ev-1",
    type: "RATING",
    occurredAt: "2026-07-02T10:00:00.000Z",
    album,
    score: 9,
    reviewBody: null,
    actor: thom,
    ...NO_REVIEW,
  },
  {
    id: "ev-2",
    type: "LISTEN",
    occurredAt: "2026-07-01T10:00:00.000Z",
    album,
    score: null,
    reviewBody: null,
    actor: jonny,
    ...NO_REVIEW,
  },
  {
    id: "ev-3",
    type: "REVIEW",
    occurredAt: "2026-06-30T10:00:00.000Z",
    album,
    score: null,
    reviewBody: "A landmark record.",
    actor: thom,
    reviewId: "rev-1",
    reviewLikeCount: 3,
    reviewCommentCount: 2,
  },
];

describe("FeedList", () => {
  it("renders each feed item with its actor, action, and album, linking to the album", () => {
    const html = renderToStaticMarkup(<FeedList items={items} />);

    // Actor attribution — the distinguishing feature of the followed feed.
    expect(html).toContain("Thom Yorke");
    expect(html).toContain("Jonny Greenwood");
    expect(html).toContain("Rated 9/10");
    expect(html).toContain("Listened to");
    expect(html).toContain("Reviewed — &quot;A landmark record.&quot;");
    expect(html).toContain("OK Computer");
    expect(html).toContain("Radiohead");
    // Every entry links back to the album detail page (built in PR9).
    expect(html).toContain('href="/albums/album-1"');
    // Each actor links to their profile page.
    expect(html).toContain('href="/u/thom"');
    expect(html).toContain('href="/u/jonny"');
  });

  it("renders a bare 'Rated' verb (not 'null/10') for a stranded rating with no score snapshot", () => {
    const orphaned: FeedItem[] = [
      {
        id: "ev-x",
        type: "RATING",
        occurredAt: "2026-07-02T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        actor: thom,
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={orphaned} />);

    expect(html).toContain("Rated");
    expect(html).not.toContain("null/10");
  });

  it("shows an explicit empty state when the feed has no activity", () => {
    const html = renderToStaticMarkup(<FeedList items={[]} />);

    expect(html).toContain("feed-empty");
    expect(html).toContain("Follow people");
  });

  it("truncates a long review body to a short snippet with an ellipsis", () => {
    const longReview: FeedItem[] = [
      {
        id: "ev-y",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: "A".repeat(120),
        actor: thom,
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={longReview} />);

    expect(html).toContain(`${"A".repeat(80)}...`);
    expect(html).not.toContain("A".repeat(120));
  });

  it("renders the bare 'Reviewed' verb for a stranded review with no body snapshot", () => {
    const orphaned: FeedItem[] = [
      {
        id: "ev-z",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        actor: thom,
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={orphaned} />);

    expect(html).toContain("Reviewed");
    expect(html).not.toContain("Reviewed — ");
  });

  it("renders the actor's avatar image with a decorative alt when avatarUrl is set", () => {
    const withAvatar: FeedItem[] = [
      {
        id: "ev-a",
        type: "LISTEN",
        occurredAt: "2026-07-01T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        actor: {
          username: "thom",
          displayName: "Thom Yorke",
          avatarUrl: "https://example.com/thom.jpg",
        },
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={withAvatar} />);

    expect(html).toContain('data-testid="feed-actor-avatar"');
    expect(html).toContain('src="https://example.com/thom.jpg"');
    expect(html).toContain('alt=""');
    expect(html).not.toContain("feed-actor-avatar-placeholder");
  });

  it("falls back to the actor's @username when their display name is empty (orphan-safe)", () => {
    const orphanedActor: FeedItem[] = [
      {
        id: "ev-o",
        type: "LISTEN",
        occurredAt: "2026-07-01T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        actor: { username: "ghost", displayName: "", avatarUrl: null },
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={orphanedActor} />);

    expect(html).toContain("@ghost");
  });

  it("hides the actor avatar initial placeholder from screen readers so it doesn't duplicate the visible name", () => {
    const noAvatar: FeedItem[] = [
      {
        id: "ev-p1",
        type: "LISTEN",
        occurredAt: "2026-07-01T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        actor: thom,
        ...NO_REVIEW,
      },
    ];

    render(<FeedList items={noAvatar} />);

    expect(
      screen
        .getByTestId("feed-actor-avatar-placeholder")
        .getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("hides the album cover initial placeholder from screen readers so it doesn't duplicate the visible title", () => {
    const noCover: FeedItem[] = [
      {
        id: "ev-p2",
        type: "LISTEN",
        occurredAt: "2026-07-01T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        actor: thom,
        ...NO_REVIEW,
      },
    ];

    render(<FeedList items={noCover} />);

    expect(
      screen.getByTestId("feed-cover-placeholder").getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("renders the album cover image with a decorative alt so the visible title isn't announced twice", () => {
    const withCover: FeedItem[] = [
      {
        id: "ev-p3",
        type: "LISTEN",
        occurredAt: "2026-07-01T10:00:00.000Z",
        album: { ...album, coverUrl: "https://example.com/cover.jpg" },
        score: null,
        reviewBody: null,
        actor: thom,
        ...NO_REVIEW,
      },
    ];

    render(<FeedList items={withCover} />);

    expect(screen.getByTestId("feed-cover").getAttribute("alt")).toBe("");
  });

  it("links a REVIEW event to its review page and shows the like and comment counts", () => {
    const html = renderToStaticMarkup(<FeedList items={items} />);

    expect(html).toContain('href="/reviews/rev-1"');
    expect(html).toContain("3 likes");
    expect(html).toContain("2 comments");
  });

  it("singularizes the counts for a review with exactly one like and one comment", () => {
    const singular: FeedItem[] = [
      {
        id: "ev-s",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: "Solid.",
        actor: thom,
        reviewId: "rev-s",
        reviewLikeCount: 1,
        reviewCommentCount: 1,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={singular} />);

    expect(html).toContain("1 like");
    expect(html).toContain("1 comment");
    expect(html).not.toContain("1 likes");
    expect(html).not.toContain("1 comments");
  });

  it("renders a zero count as a real zero rather than hiding the review row", () => {
    const untouched: FeedItem[] = [
      {
        id: "ev-0",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: "Nobody has reacted yet.",
        actor: thom,
        reviewId: "rev-0",
        reviewLikeCount: 0,
        reviewCommentCount: 0,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={untouched} />);

    // `0` is a real count from the API — only `null` means "no review".
    expect(html).toContain('href="/reviews/rev-0"');
    expect(html).toContain("0 likes");
    expect(html).toContain("0 comments");
  });

  it("renders no review link for a stranded REVIEW event whose review was deleted", () => {
    const stranded: FeedItem[] = [
      {
        id: "ev-str",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        actor: thom,
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<FeedList items={stranded} />);

    expect(html).not.toContain("/reviews/");
    expect(html).not.toContain("feed-review-link");
  });

  it("renders no review link for LISTEN and RATING events", () => {
    const html = renderToStaticMarkup(
      <FeedList items={items.filter((item) => item.type !== "REVIEW")} />,
    );

    expect(html).not.toContain("/reviews/");
  });

  it("renders the review link as a sibling of the album link, never nested inside it", () => {
    // Nested <a> is invalid HTML and triggers a React hydration error, so the
    // counts row must sit beside the album link rather than within it. The feed
    // card also wraps the actor's name in its own <a>, so assert against both.
    // `album-1` and actor `thom` are reused by other items in the fixture, so
    // the album/actor anchors are scoped to the review item's own <li> — not
    // just the first matching anchor anywhere in the container.
    render(<FeedList items={items} />);

    const reviewLink = screen.getByTestId("feed-review-link");
    const listItem = reviewLink.closest("li");
    const albumLink = listItem?.querySelector('a[href="/albums/album-1"]');
    const actorLink = listItem?.querySelector('a[href="/u/thom"]');

    expect(listItem).not.toBeNull();
    expect(albumLink).not.toBeNull();
    expect(actorLink).not.toBeNull();
    expect(albumLink?.contains(reviewLink)).toBe(false);
    expect(actorLink?.contains(reviewLink)).toBe(false);
    // `closest("a")` matches the element itself before walking up, so
    // `reviewLink.closest("a")` is always `reviewLink` — start from its
    // parent instead to actually inspect ancestors.
    expect(reviewLink.parentElement?.closest("a")).toBeNull();
  });
});

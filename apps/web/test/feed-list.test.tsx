// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { FeedList } from "../app/feed/feed-list";
import type { FeedItem } from "../lib/feed";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same spirit as the activity-feed test).
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
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
const jonny = { username: "jonny", displayName: "Jonny Greenwood", avatarUrl: null };

const items: FeedItem[] = [
  {
    id: "ev-1",
    type: "RATING",
    occurredAt: "2026-07-02T10:00:00.000Z",
    album,
    score: 9,
    reviewBody: null,
    actor: thom,
  },
  {
    id: "ev-2",
    type: "LISTEN",
    occurredAt: "2026-07-01T10:00:00.000Z",
    album,
    score: null,
    reviewBody: null,
    actor: jonny,
  },
  {
    id: "ev-3",
    type: "REVIEW",
    occurredAt: "2026-06-30T10:00:00.000Z",
    album,
    score: null,
    reviewBody: "A landmark record.",
    actor: thom,
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
    expect(html).toContain('Reviewed — &quot;A landmark record.&quot;');
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
      },
    ];

    render(<FeedList items={noAvatar} />);

    expect(
      screen.getByTestId("feed-actor-avatar-placeholder").getAttribute("aria-hidden"),
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
      },
    ];

    render(<FeedList items={withCover} />);

    expect(screen.getByTestId("feed-cover").getAttribute("alt")).toBe("");
  });
});

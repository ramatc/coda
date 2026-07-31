// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { ActivityFeed } from "../app/activity/activity-feed";
import type { ActivityItem } from "../lib/activity";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same spirit as the search-results test). The remaining props
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

const items: ActivityItem[] = [
  {
    id: "ev-1",
    type: "RATING",
    occurredAt: "2026-07-02T10:00:00.000Z",
    album,
    score: 9,
    reviewBody: null,
    ...NO_REVIEW,
  },
  {
    id: "ev-2",
    type: "LISTEN",
    occurredAt: "2026-07-01T10:00:00.000Z",
    album,
    score: null,
    reviewBody: null,
    ...NO_REVIEW,
  },
  {
    id: "ev-3",
    type: "REVIEW",
    occurredAt: "2026-06-30T10:00:00.000Z",
    album,
    score: null,
    reviewBody: "A landmark record.",
    reviewId: "rev-1",
    reviewLikeCount: 3,
    reviewCommentCount: 2,
  },
];

describe("ActivityFeed", () => {
  it("renders each activity item linking to its album detail page", () => {
    const html = renderToStaticMarkup(<ActivityFeed items={items} />);

    expect(html).toContain("Rated 9/10");
    expect(html).toContain("Listened to");
    expect(html).toContain("Reviewed — &quot;A landmark record.&quot;");
    expect(html).toContain("OK Computer");
    expect(html).toContain("Radiohead");
    // Every entry links back to the album detail page (built in PR9).
    expect(html).toContain('href="/albums/album-1"');
  });

  it("renders a bare 'Rated' verb (not 'null/10') for a stranded rating with no score snapshot", () => {
    const orphaned: ActivityItem[] = [
      {
        id: "ev-x",
        type: "RATING",
        occurredAt: "2026-07-02T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<ActivityFeed items={orphaned} />);

    expect(html).toContain("Rated");
    expect(html).not.toContain("null/10");
  });

  it("shows an explicit empty state when there is no activity", () => {
    const html = renderToStaticMarkup(<ActivityFeed items={[]} />);

    expect(html).toContain("activity-empty");
    expect(html).toContain("No activity yet");
  });

  it("truncates a long review body to a short snippet with an ellipsis", () => {
    const longReview: ActivityItem[] = [
      {
        id: "ev-y",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: "A".repeat(120),
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<ActivityFeed items={longReview} />);

    expect(html).toContain(`${"A".repeat(80)}...`);
    expect(html).not.toContain("A".repeat(120));
  });

  it("renders the bare 'Reviewed' verb for a stranded review with no body snapshot", () => {
    const orphaned: ActivityItem[] = [
      {
        id: "ev-z",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<ActivityFeed items={orphaned} />);

    expect(html).toContain("Reviewed");
    expect(html).not.toContain("Reviewed — ");
  });

  it("links a REVIEW event to its review page and shows the like and comment counts", () => {
    const html = renderToStaticMarkup(<ActivityFeed items={items} />);

    expect(html).toContain('href="/reviews/rev-1"');
    expect(html).toContain("3 likes");
    expect(html).toContain("2 comments");
  });

  it("singularizes the counts for a review with exactly one like and one comment", () => {
    const singular: ActivityItem[] = [
      {
        id: "ev-s",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: "Solid.",
        reviewId: "rev-s",
        reviewLikeCount: 1,
        reviewCommentCount: 1,
      },
    ];

    const html = renderToStaticMarkup(<ActivityFeed items={singular} />);

    expect(html).toContain("1 like");
    expect(html).toContain("1 comment");
    expect(html).not.toContain("1 likes");
    expect(html).not.toContain("1 comments");
  });

  it("renders a zero count as a real zero rather than hiding the review row", () => {
    const untouched: ActivityItem[] = [
      {
        id: "ev-0",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: "Nobody has reacted yet.",
        reviewId: "rev-0",
        reviewLikeCount: 0,
        reviewCommentCount: 0,
      },
    ];

    const html = renderToStaticMarkup(<ActivityFeed items={untouched} />);

    // `0` is a real count from the API — only `null` means "no review".
    expect(html).toContain('href="/reviews/rev-0"');
    expect(html).toContain("0 likes");
    expect(html).toContain("0 comments");
  });

  it("renders no review link for a stranded REVIEW event whose review was deleted", () => {
    const stranded: ActivityItem[] = [
      {
        id: "ev-str",
        type: "REVIEW",
        occurredAt: "2026-06-30T10:00:00.000Z",
        album,
        score: null,
        reviewBody: null,
        ...NO_REVIEW,
      },
    ];

    const html = renderToStaticMarkup(<ActivityFeed items={stranded} />);

    expect(html).not.toContain("/reviews/");
    expect(html).not.toContain("activity-review-link");
  });

  it("renders no review link for LISTEN and RATING events", () => {
    const html = renderToStaticMarkup(
      <ActivityFeed items={items.filter((item) => item.type !== "REVIEW")} />,
    );

    expect(html).not.toContain("/reviews/");
  });

  it("renders the review link as a sibling of the album link, never nested inside it", () => {
    // Nested <a> is invalid HTML and triggers a React hydration error, so the
    // counts row must sit beside the album link rather than within it.
    // `album-1` is reused by other items in the fixture, so the album anchor
    // is scoped to the review item's own <li> — not just the first matching
    // anchor anywhere in the container.
    render(<ActivityFeed items={items} />);

    const reviewLink = screen.getByTestId("activity-review-link");
    const listItem = reviewLink.closest("li");
    const albumLink = listItem?.querySelector('a[href="/albums/album-1"]');

    expect(listItem).not.toBeNull();
    expect(albumLink).not.toBeNull();
    expect(albumLink?.contains(reviewLink)).toBe(false);
    // `closest("a")` matches the element itself before walking up, so
    // `reviewLink.closest("a")` is always `reviewLink` — start from its
    // parent instead to actually inspect ancestors.
    expect(reviewLink.parentElement?.closest("a")).toBeNull();
  });
});

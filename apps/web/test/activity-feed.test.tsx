import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ActivityFeed } from "../app/activity/activity-feed";
import type { ActivityItem } from "../lib/activity";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same spirit as the search-results test).
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const album = {
  id: "album-1",
  title: "OK Computer",
  coverUrl: null,
  primaryArtistName: "Radiohead",
};

const items: ActivityItem[] = [
  {
    id: "ev-1",
    type: "RATING",
    occurredAt: "2026-07-02T10:00:00.000Z",
    album,
    score: 9,
    reviewBody: null,
  },
  {
    id: "ev-2",
    type: "LISTEN",
    occurredAt: "2026-07-01T10:00:00.000Z",
    album,
    score: null,
    reviewBody: null,
  },
  {
    id: "ev-3",
    type: "REVIEW",
    occurredAt: "2026-06-30T10:00:00.000Z",
    album,
    score: null,
    reviewBody: "A landmark record.",
  },
];

describe("ActivityFeed", () => {
  it("renders each activity item linking to its album detail page", () => {
    const html = renderToStaticMarkup(<ActivityFeed items={items} />);

    expect(html).toContain("Rated 9/10");
    expect(html).toContain("Listened to");
    expect(html).toContain('Reviewed — &quot;A landmark record.&quot;');
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
      },
    ];

    const html = renderToStaticMarkup(<ActivityFeed items={orphaned} />);

    expect(html).toContain("Reviewed");
    expect(html).not.toContain("Reviewed — ");
  });
});

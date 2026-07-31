// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ListDetailView } from "../app/lists/[id]/list-detail";
import { isListOwner, type ListDetail, type ListItem } from "../lib/lists";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same spirit as the feed-list test).
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
});

const OWNER_ID = "user-owner";

/** Builds a list item whose album title doubles as its test identity. */
function item(id: string, position: number, title: string): ListItem {
  return {
    id,
    position,
    note: null,
    album: {
      id: `album-${id}`,
      title,
      coverUrl: null,
      primaryArtistName: "Radiohead",
    },
  };
}

/** Builds a list detail with the given overrides applied. */
function list(overrides: Partial<ListDetail> = {}): ListDetail {
  return {
    id: "list-1",
    userId: OWNER_ID,
    title: "Best of 2026",
    description: "A ranked run through the year.",
    isRanked: true,
    isPublic: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    items: [item("a", 1, "Kid A"), item("b", 2, "Amnesiac")],
    likeCount: 0,
    viewerHasLiked: false,
    ...overrides,
  };
}

/** The album titles currently rendered, in row order. */
function renderedTitles(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => within(row).getByRole("link").textContent ?? "");
}

describe("isListOwner", () => {
  it("is true when the viewer's local user id matches the list owner", () => {
    expect(isListOwner(list(), OWNER_ID)).toBe(true);
  });

  it("is false for a different signed-in user", () => {
    expect(isListOwner(list(), "user-visitor")).toBe(false);
  });

  it("is false when the viewer's id could not be resolved (degrades to visitor)", () => {
    expect(isListOwner(list(), null)).toBe(false);
  });
});

describe("ListDetailView", () => {
  it("renders the list title and description", () => {
    render(<ListDetailView list={list()} isOwner={false} />);

    expect(
      screen.getByRole("heading", { name: "Best of 2026" }),
    ).not.toBeNull();
    expect(
      screen.getByText("A ranked run through the year."),
    ).not.toBeNull();
  });

  it("falls back to a placeholder when the list has no description", () => {
    render(<ListDetailView list={list({ description: null })} isOwner={false} />);

    expect(screen.getByText("No description yet.")).not.toBeNull();
  });

  it("summarizes a ranked list and its album count", () => {
    render(<ListDetailView list={list()} isOwner={false} />);

    const summary = screen.getByTestId("list-summary").textContent ?? "";
    expect(summary).toContain("Ranked");
    expect(summary).toContain("2 albums");
  });

  it("summarizes an unranked single-album list without pluralizing", () => {
    render(
      <ListDetailView
        list={list({ isRanked: false, items: [item("a", 1, "Kid A")] })}
        isOwner={false}
      />,
    );

    const summary = screen.getByTestId("list-summary").textContent ?? "";
    expect(summary).toContain("Unranked");
    expect(summary).toContain("1 album");
    expect(summary).not.toContain("1 albums");
  });

  it("shows the owner that their list is private", () => {
    render(<ListDetailView list={list({ isPublic: false })} isOwner={true} />);

    expect(screen.getByText("Private")).not.toBeNull();
  });

  it("does not label a public list as private", () => {
    render(<ListDetailView list={list({ isPublic: true })} isOwner={true} />);

    expect(screen.queryByText("Private")).toBeNull();
  });

  it("renders a read-only ordered item list for a visitor", () => {
    render(
      <ListDetailView list={list()} isOwner={false}>
        <div>reorder island</div>
      </ListDetailView>,
    );

    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac"]);
    expect(screen.getByRole("link", { name: "Kid A" }).getAttribute("href")).toBe(
      "/albums/album-a",
    );
    // The owner-only island is never handed to a visitor.
    expect(screen.queryByText("reorder island")).toBeNull();
  });

  it("renders a visitor's empty state instead of an item list", () => {
    render(<ListDetailView list={list({ items: [] })} isOwner={false} />);

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No albums on this list yet.")).not.toBeNull();
  });

  it("swaps the read-only list for the owner's reorder island", () => {
    render(
      <ListDetailView list={list()} isOwner={true}>
        <div>reorder island</div>
      </ListDetailView>,
    );

    expect(screen.getByText("reorder island")).not.toBeNull();
    // The static list is replaced, not duplicated alongside the island.
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("falls back to the read-only list when the owner island is absent", () => {
    render(<ListDetailView list={list()} isOwner={true} />);

    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac"]);
  });

  it("renders the owner's edit and delete controls", () => {
    render(
      <ListDetailView
        list={list()}
        isOwner={true}
        ownerActions={<div>owner actions</div>}
      />,
    );

    expect(screen.getByText("owner actions")).not.toBeNull();
  });

  it("never hands the owner controls to a visitor", () => {
    render(
      <ListDetailView
        list={list()}
        isOwner={false}
        ownerActions={<div>owner actions</div>}
      />,
    );

    expect(screen.queryByText("owner actions")).toBeNull();
  });

  it("surfaces a notice when ownership could not be verified", () => {
    render(
      <ListDetailView list={list()} isOwner={false} ownershipUnverified={true} />,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "Some features may be unavailable right now — refresh to retry.",
    );
  });

  it("shows no ownership notice once ownership is resolved either way", () => {
    render(<ListDetailView list={list()} isOwner={false} />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

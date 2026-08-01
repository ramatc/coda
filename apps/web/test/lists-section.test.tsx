// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ListsSection } from "../app/u/[username]/lists-section";
import type { ListSummary } from "../lib/lists";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same posture as the list-detail and feed-list tests).
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

afterEach(() => {
  cleanup();
});

/** Builds a list summary whose title doubles as its test identity. */
function summary(
  id: string,
  title: string,
  overrides: Partial<ListSummary> = {},
): ListSummary {
  return {
    id,
    title,
    description: null,
    isRanked: false,
    isPublic: true,
    itemCount: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

const LISTS: ListSummary[] = [
  summary("l1", "Best of 2026", { isRanked: true, itemCount: 3 }),
  summary("l2", "Rainy day", { itemCount: 1 }),
  summary("l3", "Unsorted", {}),
];

/** The list titles currently rendered, in row order. */
function renderedTitles(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => within(row).getByRole("link").textContent ?? "");
}

/** The Nth rendered row, asserted present so a short render fails loudly here. */
function row(index: number): HTMLElement {
  const rows = screen.getAllByRole("listitem");
  const found = rows[index];
  if (found === undefined) {
    throw new Error(`Expected a row at index ${index}, got ${rows.length}.`);
  }
  return found;
}

describe("ListsSection", () => {
  it("renders every list in the order the API returned it, each linked to its detail page", () => {
    render(<ListsSection lists={LISTS} isOwnProfile={false} />);

    // The API already orders these newest-first; the section never re-sorts.
    expect(renderedTitles()).toEqual(["Best of 2026", "Rainy day", "Unsorted"]);
    expect(
      screen.getByRole("link", { name: "Best of 2026" }).getAttribute("href"),
    ).toBe("/lists/l1");
    expect(
      screen.getByRole("link", { name: "Unsorted" }).getAttribute("href"),
    ).toBe("/lists/l3");
  });

  it("renders as its own labelled section, distinct from the profile's other sections", () => {
    render(<ListsSection lists={LISTS} isOwnProfile={false} />);

    const section = screen.getByRole("region", { name: "Lists" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(section).getByRole("heading", { name: "Lists" }),
    ).not.toBeNull();
  });

  it("summarizes each list with its ranking and its album count, singularized", () => {
    render(<ListsSection lists={LISTS} isOwnProfile={false} />);

    expect(within(row(0)).getByText("Ranked · 3 albums")).not.toBeNull();
    expect(within(row(1)).getByText("Unranked · 1 album")).not.toBeNull();
    expect(within(row(2)).getByText("Unranked · 0 albums")).not.toBeNull();
  });

  it("shows a list's description when it has one and stays quiet when it does not", () => {
    render(
      <ListsSection
        lists={[
          summary("l1", "Best of 2026", { description: "A ranked year." }),
          summary("l2", "Rainy day"),
        ]}
        isOwnProfile={false}
      />,
    );

    expect(within(row(0)).getByText("A ranked year.")).not.toBeNull();
    // A profile card must not carry the list page's "No description yet."
    // placeholder — a bare row is quieter than a row full of absences.
    expect(row(1).textContent).toBe("Rainy dayUnranked · 0 albums");
  });

  it("marks the owner's own private lists as private", () => {
    render(
      <ListsSection
        lists={[
          summary("l1", "Secret picks", { isPublic: false, itemCount: 2 }),
          summary("l2", "Rainy day", { itemCount: 2 }),
        ]}
        isOwnProfile={true}
      />,
    );

    expect(
      within(row(0)).getByText("Unranked · 2 albums · Private"),
    ).not.toBeNull();
    expect(within(row(1)).getByText("Unranked · 2 albums")).not.toBeNull();
  });

  it("never renders the private marker on someone else's profile", () => {
    // The API only ever sends private lists to their owner, so this can only
    // happen if that contract breaks — the marker is owner-scoped copy either
    // way and must not leak onto a visitor's view.
    render(
      <ListsSection
        lists={[summary("l1", "Secret picks", { isPublic: false })]}
        isOwnProfile={false}
      />,
    );

    expect(screen.queryByText(/Private/)).toBeNull();
  });

  it("still renders the section with an empty state and a create link on the owner's own profile", () => {
    render(<ListsSection lists={[]} isOwnProfile={true} />);

    // The section MUST exist even when empty — an absent section, or an error,
    // is the failure mode this guards against.
    expect(screen.getByRole("region", { name: "Lists" })).not.toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No lists yet.")).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Create your first list" })
        .getAttribute("href"),
    ).toBe("/lists/new");
  });

  it("tells a visitor an empty profile has no PUBLIC lists and offers them nothing to create", () => {
    render(<ListsSection lists={[]} isOwnProfile={false} />);

    expect(screen.getByRole("region", { name: "Lists" })).not.toBeNull();
    // "No public lists yet." rather than "No lists yet.": a visitor cannot tell
    // the difference between a user with nothing and a user whose lists are all
    // private, and the copy must not claim the former.
    expect(screen.getByText("No public lists yet.")).not.toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("offers no create link once the owner already has lists", () => {
    render(<ListsSection lists={LISTS} isOwnProfile={true} />);

    // The create affordance is the empty state's call to action, not a
    // permanent header action on the profile.
    expect(
      screen.queryByRole("link", { name: "Create your first list" }),
    ).toBeNull();
  });
});

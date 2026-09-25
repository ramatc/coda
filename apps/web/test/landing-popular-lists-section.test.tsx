// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { PopularList } from "../lib/lists";

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

const { PopularListsSection } =
  await import("../app/_landing/popular-lists-section");

afterEach(() => {
  cleanup();
});

const COVERS = [
  "https://cdn.example/1.jpg",
  "https://cdn.example/2.jpg",
  "https://cdn.example/3.jpg",
  "https://cdn.example/4.jpg",
];

const LISTS: PopularList[] = [
  {
    id: "list-1",
    title: "Best of 2026",
    description: "A ranked run through the year.",
    isRanked: true,
    itemCount: 12,
    likeCount: 5,
    createdAt: "2026-07-01T00:00:00.000Z",
    owner: { username: "ada", displayName: "Ada", avatarUrl: null },
    previewCovers: COVERS,
  },
  {
    id: "list-2",
    title: "Night drives",
    description: null,
    isRanked: false,
    itemCount: 1,
    likeCount: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
    owner: { username: "lin", displayName: "", avatarUrl: null },
    previewCovers: [],
  },
];

/** The labelled section region, located by its visible heading. */
function listsRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Popular lists" });
}

/** The list cards, asserted to match `expected` before any caller iterates them. */
function listCards(expected: number = LISTS.length): HTMLElement[] {
  const cards = within(listsRegion()).getAllByRole("listitem");
  expect(cards).toHaveLength(expected);
  return cards;
}

/** Cover `src`s in a card's collage (decorative, so not exposed as `img`). */
function collageSources(card: HTMLElement): (string | null)[] {
  return Array.from(card.querySelectorAll("img")).map((img) =>
    img.getAttribute("src"),
  );
}

describe("PopularListsSection", () => {
  it("is the `lists` anchor target the landing nav links to", () => {
    const { container } = render(<PopularListsSection lists={LISTS} />);

    const region = listsRegion();
    expect(region.id).toBe("lists");
    expect(container.querySelector("#lists")).toBe(region);
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe(
      "Popular lists",
    );
  });

  it("titles each card with its list, linking to the list page", () => {
    render(<PopularListsSection lists={LISTS} />);

    const headings = listCards().map((card) =>
      within(card).getByRole("heading", { level: 3 }),
    );
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Best of 2026",
      "Night drives",
    ]);
    expect(
      headings.map((heading) =>
        within(heading).getByRole("link").getAttribute("href"),
      ),
    ).toEqual(["/lists/list-1", "/lists/list-2"]);
  });

  it("credits the owner, falling back to the handle", () => {
    render(<PopularListsSection lists={LISTS} />);

    const [first, second] = listCards();
    expect(within(first!).getByText("by Ada")).toBeTruthy();
    // A missing profile degrades to a blank display name API-side.
    expect(within(second!).getByText("by @lin")).toBeTruthy();
  });

  it("labels the album and like counts, singular and plural", () => {
    render(<PopularListsSection lists={LISTS} />);

    const [first, second] = listCards();
    expect(within(first!).getByText("12 albums")).toBeTruthy();
    expect(within(first!).getByText("5 likes")).toBeTruthy();
    expect(within(second!).getByText("1 album")).toBeTruthy();
    expect(within(second!).getByText("1 like")).toBeTruthy();
  });

  it("marks a ranked list and shows a description only when there is one", () => {
    render(<PopularListsSection lists={LISTS} />);

    const [first, second] = listCards();
    expect(within(first!).getByText("Ranked")).toBeTruthy();
    expect(within(first!).getByTestId("list-description").textContent).toBe(
      "A ranked run through the year.",
    );
    expect(within(second!).queryByText("Ranked")).toBeNull();
    expect(within(second!).queryByTestId("list-description")).toBeNull();
  });

  it("builds the collage from the preview covers, in order", () => {
    render(<PopularListsSection lists={LISTS} />);

    const [first, second] = listCards();
    expect(collageSources(first!)).toEqual(COVERS);
    expect(collageSources(second!)).toEqual([]);
    expect(
      within(second!).getByTestId("list-collage-placeholder"),
    ).toBeTruthy();
    expect(within(first!).queryByTestId("list-collage-placeholder")).toBeNull();
  });

  it("never draws more than four covers, even if handed more", () => {
    const crowded: PopularList = {
      ...LISTS[0]!,
      previewCovers: [...COVERS, "https://cdn.example/5.jpg"],
    };
    render(<PopularListsSection lists={[crowded]} />);

    const [card] = listCards(1);
    expect(collageSources(card!)).toEqual(COVERS);
  });

  it("keeps the section and heading but shows an empty state with no lists", () => {
    render(<PopularListsSection lists={[]} />);

    const region = listsRegion();
    expect(region.id).toBe("lists");
    expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(region).getByText(/no public lists yet/i)).toBeTruthy();
  });
});

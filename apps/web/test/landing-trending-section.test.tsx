// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { PopularAlbum } from "../lib/search";

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

const { TrendingSection } = await import("../app/_landing/trending-section");

afterEach(() => {
  cleanup();
});

const ALBUMS: PopularAlbum[] = [
  {
    id: "album-1",
    title: "Kid A",
    coverUrl: "https://cdn.example/kid-a.jpg",
    primaryArtistName: "Radiohead",
  },
  {
    id: "album-2",
    title: "blue",
    coverUrl: null,
    primaryArtistName: "Joni Mitchell",
  },
];

/** The labelled section region, located by its visible heading. */
function trendingRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Trending tonight" });
}

describe("TrendingSection", () => {
  it("is the `trending` anchor target the hero and nav link to", () => {
    const { container } = render(<TrendingSection albums={ALBUMS} />);

    const region = trendingRegion();
    expect(region.id).toBe("trending");
    expect(container.querySelector("#trending")).toBe(region);
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe(
      "Trending tonight",
    );
  });

  it("renders one card per album, in order, linking to its album page", () => {
    render(<TrendingSection albums={ALBUMS} />);

    const cards = within(trendingRegion()).getAllByRole("listitem");
    expect(cards).toHaveLength(2);

    const links = cards.map((card) => within(card).getByRole("link"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/albums/album-1",
      "/albums/album-2",
    ]);
    expect(within(cards[0]!).getByText("Kid A")).toBeTruthy();
    expect(within(cards[0]!).getByText("Radiohead")).toBeTruthy();
    expect(within(cards[1]!).getByText("blue")).toBeTruthy();
    expect(within(cards[1]!).getByText("Joni Mitchell")).toBeTruthy();
  });

  it("shows the cover art when there is one, and a placeholder otherwise", () => {
    render(<TrendingSection albums={ALBUMS} />);

    const cards = within(trendingRegion()).getAllByRole("listitem");
    const cover = within(cards[0]!).getByRole("img", { name: "Kid A cover" });
    expect(cover.getAttribute("src")).toBe("https://cdn.example/kid-a.jpg");
    expect(within(cards[1]!).queryByRole("img")).toBeNull();
    expect(
      within(cards[1]!).getByTestId("trending-cover-placeholder").textContent,
    ).toBe("B");
  });

  it("keeps the section and heading but shows an empty state with no albums", () => {
    render(<TrendingSection albums={[]} />);

    const region = trendingRegion();
    expect(region.id).toBe("trending");
    expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(region).getByText(/nothing is trending yet/i)).toBeTruthy();
  });
});

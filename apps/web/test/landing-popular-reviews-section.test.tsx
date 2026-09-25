// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { PopularReview } from "../lib/reviews";

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

const { PopularReviewsSection } =
  await import("../app/_landing/popular-reviews-section");

afterEach(() => {
  cleanup();
});

const REVIEWS: PopularReview[] = [
  {
    id: "review-1",
    body: "A slow burn that finally clicks on the fourth listen.",
    isSpoiler: false,
    score: 9,
    createdAt: "2026-07-01T00:00:00.000Z",
    album: {
      id: "album-1",
      title: "Kid A",
      coverUrl: "https://cdn.example/kid-a.jpg",
      primaryArtistName: "Radiohead",
    },
    author: { username: "thom", displayName: "Thom", avatarUrl: null },
    likeCount: 3,
    commentCount: 1,
  },
  {
    id: "review-2",
    body: "The closer is where she finally lets go.",
    isSpoiler: true,
    score: 7,
    createdAt: "2026-06-30T00:00:00.000Z",
    album: {
      id: "album-2",
      title: "blue",
      coverUrl: null,
      primaryArtistName: "Joni Mitchell",
    },
    author: { username: "ed", displayName: "  ", avatarUrl: null },
    likeCount: 1,
    commentCount: 0,
  },
];

/** The labelled section region, located by its visible heading. */
function reviewsRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Popular reviews" });
}

/** The review cards, asserted non-empty before any caller iterates them. */
function reviewCards(): HTMLElement[] {
  const cards = within(reviewsRegion()).getAllByRole("listitem");
  expect(cards).toHaveLength(REVIEWS.length);
  return cards;
}

describe("PopularReviewsSection", () => {
  it("is the `reviews` anchor target the landing nav links to", () => {
    const { container } = render(<PopularReviewsSection reviews={REVIEWS} />);

    const region = reviewsRegion();
    expect(region.id).toBe("reviews");
    expect(container.querySelector("#reviews")).toBe(region);
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe(
      "Popular reviews",
    );
  });

  it("titles each card with its album, linking to the public review page", () => {
    render(<PopularReviewsSection reviews={REVIEWS} />);

    const headings = reviewCards().map((card) =>
      within(card).getByRole("heading", { level: 3 }),
    );
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Kid A",
      "blue",
    ]);
    expect(
      headings.map((heading) =>
        within(heading).getByRole("link").getAttribute("href"),
      ),
    ).toEqual(["/reviews/review-1", "/reviews/review-2"]);
  });

  it("renders each author's score through RatingScale", () => {
    render(<PopularReviewsSection reviews={REVIEWS} />);

    const [first, second] = reviewCards();
    expect(within(first!).getByLabelText("Rating 9.0 out of 10")).toBeTruthy();
    expect(within(second!).getByLabelText("Rating 7.0 out of 10")).toBeTruthy();
    expect(within(first!).getAllByTestId("rating-scale")).toHaveLength(1);
  });

  it("credits the artist and the author, falling back to the handle", () => {
    render(<PopularReviewsSection reviews={REVIEWS} />);

    const [first, second] = reviewCards();
    expect(within(first!).getByText("Radiohead")).toBeTruthy();
    expect(within(first!).getByText("Thom")).toBeTruthy();
    expect(within(second!).getByText("Joni Mitchell")).toBeTruthy();
    // A missing profile degrades to a blank display name API-side.
    expect(within(second!).getByText("@ed")).toBeTruthy();
  });

  it("shows the body of a normal review but hides a spoiler behind a notice", () => {
    render(<PopularReviewsSection reviews={REVIEWS} />);

    const [first, second] = reviewCards();
    expect(within(first!).getByText(REVIEWS[0]!.body)).toBeTruthy();
    expect(within(first!).queryByText(/contains spoilers/i)).toBeNull();
    expect(within(second!).queryByText(REVIEWS[1]!.body)).toBeNull();
    expect(within(second!).getByText(/contains spoilers/i)).toBeTruthy();
  });

  it("labels the like and comment counts", () => {
    render(<PopularReviewsSection reviews={REVIEWS} />);

    const [first, second] = reviewCards();
    expect(within(first!).getByText("3 likes")).toBeTruthy();
    expect(within(first!).getByText("1 comment")).toBeTruthy();
    expect(within(second!).getByText("1 like")).toBeTruthy();
    expect(within(second!).getByText("0 comments")).toBeTruthy();
  });

  it("uses the cover art when there is one, and a placeholder otherwise", () => {
    render(<PopularReviewsSection reviews={REVIEWS} />);

    const [first, second] = reviewCards();
    expect(
      within(first!)
        .getByRole("img", { name: "Kid A cover" })
        .getAttribute("src"),
    ).toBe("https://cdn.example/kid-a.jpg");
    expect(within(second!).queryByRole("img")).toBeNull();
    expect(
      within(second!).getByTestId("review-cover-placeholder").textContent,
    ).toBe("B");
  });

  it("keeps the section and heading but shows an empty state with no reviews", () => {
    render(<PopularReviewsSection reviews={[]} />);

    const region = reviewsRegion();
    expect(region.id).toBe("reviews");
    expect(within(region).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(region).getByText(/no reviews to show yet/i)).toBeTruthy();
  });
});

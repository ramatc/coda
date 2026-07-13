// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Recommendations } from "../app/home/recommendations";
import type { Recommendation } from "../lib/recommendations";
import { dismissRecommendation } from "../lib/recommendations";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

// Render next/link as a plain anchor so the island renders without a router
// context (same spirit as the activity-feed / search-results tests).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../lib/recommendations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/recommendations")>();
  return { ...actual, dismissRecommendation: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(dismissRecommendation).mockReset().mockResolvedValue(undefined);
});

const ITEMS: Recommendation[] = [
  {
    id: "rec-1",
    score: 0.72,
    reason: { topGenre: "Rock", matchedArtist: true },
    album: {
      id: "album-1",
      title: "OK Computer",
      coverUrl: null,
      releaseYear: 1997,
      primaryArtistName: "Radiohead",
    },
  },
  {
    id: "rec-2",
    score: 0.4,
    reason: { topGenre: "Jazz", matchedArtist: false },
    album: {
      id: "album-2",
      title: "Blue Train",
      coverUrl: null,
      releaseYear: 1957,
      primaryArtistName: "John Coltrane",
    },
  },
];

describe("Recommendations island", () => {
  it("renders each recommendation card linking to its album detail page", () => {
    render(<Recommendations items={ITEMS} />);

    expect(screen.getByText("OK Computer")).toBeDefined();
    expect(screen.getByText("Blue Train")).toBeDefined();
    // Artist-match reason vs genre-only reason.
    expect(screen.getByText("Because you follow this artist")).toBeDefined();
    expect(screen.getByText("Because you like Jazz")).toBeDefined();

    const links = screen.getAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/albums/album-1");
    expect(hrefs).toContain("/albums/album-2");
  });

  it("dismisses a recommendation: calls the API, hides the card, refreshes", async () => {
    render(<Recommendations items={ITEMS} />);

    fireEvent.click(screen.getByLabelText("Dismiss OK Computer"));

    await waitFor(() => {
      expect(dismissRecommendation).toHaveBeenCalledWith("test-token", "rec-1");
    });
    await waitFor(() => {
      expect(screen.queryByText("OK Computer")).toBeNull();
    });
    expect(refreshMock).toHaveBeenCalled();
    // The other card is untouched.
    expect(screen.getByText("Blue Train")).toBeDefined();
  });

  it("keeps the card and shows an error when the dismiss fails", async () => {
    vi.mocked(dismissRecommendation).mockRejectedValueOnce(
      new Error("Could not dismiss this recommendation."),
    );

    render(<Recommendations items={ITEMS} />);
    fireEvent.click(screen.getByLabelText("Dismiss OK Computer"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
    // Not optimistically removed on failure.
    expect(screen.getByText("OK Computer")).toBeDefined();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("shows an explicit empty state when there are no recommendations", () => {
    render(<Recommendations items={[]} />);

    expect(screen.getByTestId("recommendations-empty")).toBeDefined();
  });
});

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

  it("does not surface a refresh failure after a successful dismiss", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });

    render(<Recommendations items={ITEMS} />);
    fireEvent.click(screen.getByLabelText("Dismiss OK Computer"));

    await waitFor(() => {
      expect(dismissRecommendation).toHaveBeenCalledWith("test-token", "rec-1");
    });
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The dismiss already persisted, so the card stays hidden…
    await waitFor(() => expect(screen.queryByText("OK Computer")).toBeNull());
    // …and a throwing `router.refresh()` must not be misreported as a failed
    // dismiss: an error banner over a card that is (correctly) gone tells the
    // viewer their dismiss failed when the server recorded it.
    expect(screen.queryByRole("alert")).toBeNull();
    // The control is released either way, so a retry stays possible.
    expect(
      (screen.getByLabelText("Dismiss Blue Train") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("tracks in-flight dismisses per card, so dismissing a second card does not re-enable the first", async () => {
    // One resolver per id, so each card's request can be held in flight and
    // released independently.
    const resolvers = new Map<string, () => void>();
    vi.mocked(dismissRecommendation).mockImplementation(
      (_token, id) =>
        new Promise<void>((resolve) => {
          resolvers.set(id, resolve);
        }),
    );

    render(<Recommendations items={ITEMS} />);

    const first = screen.getByLabelText(
      "Dismiss OK Computer",
    ) as HTMLButtonElement;
    const second = screen.getByLabelText(
      "Dismiss Blue Train",
    ) as HTMLButtonElement;

    fireEvent.click(first);
    await waitFor(() =>
      expect(dismissRecommendation).toHaveBeenCalledWith("test-token", "rec-1"),
    );
    expect(first.disabled).toBe(true);

    // The first dismiss is still in flight when the user dismisses another
    // card. Tracking a single "pending id" would hand the pending flag over to
    // the second card and silently release the first.
    fireEvent.click(second);
    await waitFor(() =>
      expect(dismissRecommendation).toHaveBeenCalledWith("test-token", "rec-2"),
    );

    expect(second.disabled).toBe(true);
    expect(first.disabled).toBe(true);

    // …and the still-blocked first card cannot fire a second concurrent
    // dismiss for the same recommendation.
    fireEvent.click(first);
    expect(dismissRecommendation).toHaveBeenCalledTimes(2);

    // Releasing one request clears only that card's pending state.
    resolvers.get("rec-1")?.();
    await waitFor(() => expect(screen.queryByText("OK Computer")).toBeNull());
    expect(second.disabled).toBe(true);

    resolvers.get("rec-2")?.();
    await waitFor(() => expect(screen.queryByText("Blue Train")).toBeNull());
  });

  it("shows an explicit empty state when there are no recommendations", () => {
    render(<Recommendations items={[]} />);

    expect(screen.getByTestId("recommendations-empty")).toBeDefined();
  });
});

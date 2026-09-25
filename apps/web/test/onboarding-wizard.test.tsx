// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "../app/onboarding/onboarding-wizard";
import { MAX_ARTISTS, MIN_GENRES, type GenreOption } from "../lib/onboarding";

/**
 * Component-level tests for the onboarding wizard client island. Complements
 * the pure-function tests in `lib/onboarding.ts` (exercised indirectly by
 * `onboarding-gate.test.ts`) by proving the actual rendered behavior: the
 * MAX_ARTISTS cap disables further selection, a failed search fails safe
 * instead of crashing or discarding prior results, the artists/albums steps
 * default to genre-based suggestions before any query is typed, the genre
 * category filter narrows the visible grid, and CTA enablement tracks the
 * real selection rules.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const GENRES: GenreOption[] = [
  { slug: "rock", name: "Rock", category: "Rock & Punk", descriptor: "Guitar-driven, riff-heavy, arena to garage" },
  { slug: "pop", name: "Pop", category: "Pop & Global", descriptor: "Hook-driven, polished, chart-focused mainstream" },
  { slug: "jazz", name: "Jazz", category: "Jazz & Blues", descriptor: "Modal, spiritual, fusion & hard bop" },
];

function artist(i: number) {
  return { id: `artist-${i}`, name: `Artist ${i}`, imageUrl: null };
}

/** Selects the 3 fixture genres and advances to the "artists" step. */
async function goToArtistsStep(): Promise<void> {
  for (const genre of GENRES) {
    fireEvent.click(screen.getByText(genre.name));
  }
  fireEvent.click(screen.getByRole("button", { name: /^Next/ }));
  await screen.findByPlaceholderText("Search artists…");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OnboardingWizard", () => {
  it("selecting artists respects the MAX_ARTISTS cap: further unselected results become disabled no-ops", async () => {
    const results = Array.from({ length: MAX_ARTISTS + 1 }, (_, i) => artist(i));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => results }),
    );

    render(<OnboardingWizard genres={GENRES} />);
    await goToArtistsStep();

    fireEvent.change(screen.getByPlaceholderText("Search artists…"), {
      target: { value: "art" },
    });

    await waitFor(
      () => expect(screen.getByText("Artist 0")).toBeTruthy(),
      { timeout: 2000 },
    );

    // Select exactly MAX_ARTISTS results, filling the cap.
    for (let i = 0; i < MAX_ARTISTS; i++) {
      fireEvent.click(screen.getByText(`Artist ${i}`).closest("button")!);
    }

    expect(
      screen.getByText(`(${MAX_ARTISTS} selected)`, { exact: false }),
    ).toBeTruthy();

    // The one remaining unselected result is now disabled and no-ops on click.
    const capButton = screen
      .getByText(`Artist ${MAX_ARTISTS}`)
      .closest("button") as HTMLButtonElement;
    expect(capButton.disabled).toBe(true);

    fireEvent.click(capButton);
    expect(
      screen.getByText(`(${MAX_ARTISTS} selected)`, { exact: false }),
    ).toBeTruthy();

    // An already-selected item stays clickable so the user can still deselect.
    const selectedButton = screen.getByText("Artist 0").closest("button") as HTMLButtonElement;
    expect(selectedButton.disabled).toBe(false);
  });

  it("a failed search does not crash the component and preserves prior results", async () => {
    const initialResults = [artist(0), artist(1)];
    // Entering the artists step now also fires a genre-based
    // `.../artists/suggested` request (see the new suggestion tests below),
    // so the mock routes by URL rather than relying on raw call order: the
    // suggestion request always resolves empty (irrelevant to this test),
    // and only the `?q=`-bearing search requests follow the original
    // succeed-then-fail sequence this test exercises.
    let searchCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/suggested")) {
        return { ok: true, json: async () => [] };
      }
      searchCalls += 1;
      if (searchCalls === 1) {
        return { ok: true, json: async () => initialResults };
      }
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OnboardingWizard genres={GENRES} />);
    await goToArtistsStep();

    const input = screen.getByPlaceholderText("Search artists…");

    fireEvent.change(input, { target: { value: "art" } });
    await waitFor(() => expect(screen.getByText("Artist 0")).toBeTruthy(), {
      timeout: 2000,
    });
    expect(screen.getByText("Artist 1")).toBeTruthy();

    fireEvent.change(input, { target: { value: "artx" } });

    // Give the debounced, now-rejecting search a chance to settle. It must not
    // throw an unhandled rejection, and the previously-rendered results must
    // remain on screen instead of being cleared.
    await waitFor(() => expect(searchCalls).toBe(2), {
      timeout: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText("Artist 0")).toBeTruthy();
    expect(screen.getByText("Artist 1")).toBeTruthy();
  });

  it("defaults the artists step to genre-based suggestions before any query is typed", async () => {
    const suggested = [artist(0), artist(1)];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/artists/suggested")) {
        return { ok: true, json: async () => suggested };
      }
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OnboardingWizard genres={GENRES} />);
    await goToArtistsStep();

    // No query typed yet — the grid should already show the genre-based
    // suggestions, not the empty state.
    await waitFor(() => expect(screen.getByText("Artist 0")).toBeTruthy(), {
      timeout: 2000,
    });
    expect(screen.getByText("Artist 1")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/onboarding/artists/suggested?genres="),
      ),
    ).toBe(true);
  });

  it("defaults the albums step to genre-based suggestions before any query is typed", async () => {
    const suggestedArtist = artist(0);
    const suggestedAlbum = {
      id: "album-0",
      title: "Album Zero",
      coverUrl: null,
      primaryArtistName: "Artist 0",
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/artists/suggested")) {
        return { ok: true, json: async () => [suggestedArtist] };
      }
      if (url.includes("/albums/suggested")) {
        return { ok: true, json: async () => [suggestedAlbum] };
      }
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OnboardingWizard genres={GENRES} />);
    await goToArtistsStep();

    await waitFor(() => expect(screen.getByText("Artist 0")).toBeTruthy(), {
      timeout: 2000,
    });
    fireEvent.click(screen.getByText("Artist 0").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /^Next/ }));

    await waitFor(
      () => expect(screen.getByText("Album Zero")).toBeTruthy(),
      { timeout: 2000 },
    );
  });

  it("narrows the genre grid with the category filter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    render(<OnboardingWizard genres={GENRES} />);

    // All three fixture genres are visible by default.
    expect(screen.getByText("Rock")).toBeTruthy();
    expect(screen.getByText("Pop")).toBeTruthy();
    expect(screen.getByText("Jazz")).toBeTruthy();

    // Filtering to Jazz's category hides the other genres.
    fireEvent.click(screen.getByText("Jazz & Blues"));
    expect(screen.getByText("Jazz")).toBeTruthy();
    expect(screen.queryByText("Rock")).toBeNull();
    expect(screen.queryByText("Pop")).toBeNull();

    // Clicking the active pill again clears the filter.
    fireEvent.click(screen.getByText("Jazz & Blues"));
    expect(screen.getByText("Rock")).toBeTruthy();
    expect(screen.getByText("Pop")).toBeTruthy();
    expect(screen.getByText("Jazz")).toBeTruthy();
  });

  it("keeps the genres Next CTA disabled until MIN_GENRES are selected, matching the real rule", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    render(<OnboardingWizard genres={GENRES} />);

    const nextButton = screen.getByRole("button", { name: /^Next/ }) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(true);

    for (const genre of GENRES.slice(0, MIN_GENRES - 1)) {
      fireEvent.click(screen.getByText(genre.name));
    }
    expect(nextButton.disabled).toBe(true);

    const lastGenre = GENRES[MIN_GENRES - 1];
    if (!lastGenre) throw new Error("fixture must have at least MIN_GENRES genres");
    fireEvent.click(screen.getByText(lastGenre.name));
    expect(nextButton.disabled).toBe(false);
  });
});

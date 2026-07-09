// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "../app/onboarding/onboarding-wizard";
import { MAX_ARTISTS, type GenreOption } from "../lib/onboarding";

/**
 * Component-level tests for the onboarding wizard client island. Complements
 * the pure-function tests in `lib/onboarding.ts` (exercised indirectly by
 * `onboarding-gate.test.ts`) by proving the actual rendered behavior: the
 * MAX_ARTISTS cap disables further selection, and a failed search fails safe
 * instead of crashing or discarding prior results.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const GENRES: GenreOption[] = [
  { slug: "rock", name: "Rock" },
  { slug: "pop", name: "Pop" },
  { slug: "jazz", name: "Jazz" },
];

function artist(i: number) {
  return { id: `artist-${i}`, name: `Artist ${i}`, imageUrl: null };
}

/** Selects the 3 fixture genres and advances to the "artists" step. */
async function goToArtistsStep(): Promise<void> {
  for (const genre of GENRES) {
    fireEvent.click(screen.getByText(genre.name));
  }
  fireEvent.click(screen.getByText("Next"));
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialResults })
      .mockRejectedValueOnce(new Error("network down"));
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText("Artist 0")).toBeTruthy();
    expect(screen.getByText("Artist 1")).toBeTruthy();
  });
});

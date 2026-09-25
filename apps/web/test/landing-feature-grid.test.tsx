// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * Tripwire: the feature grid is static copy. If it ever reaches for the
 * network, this spy records the call and the test below fails.
 */
const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

const { FeatureGrid } = await import("../app/_landing/feature-grid");

afterEach(() => {
  cleanup();
  fetchSpy.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("FeatureGrid", () => {
  it("is the `features` anchor target the landing nav links to", () => {
    const { container } = render(<FeatureGrid />);

    const region = screen.getByRole("region", {
      name: "Everything your listening deserves",
    });
    expect(region.id).toBe("features");
    expect(container.querySelector("#features")).toBe(region);
  });

  it("lists every feature card in order, each with a title and description", () => {
    render(<FeatureGrid />);

    const region = screen.getByRole("region", {
      name: "Everything your listening deserves",
    });
    const cards = within(region).getAllByRole("listitem");
    expect(cards).toHaveLength(4);

    const titles = cards.map(
      (card) => within(card).getByRole("heading", { level: 3 }).textContent,
    );
    expect(titles).toEqual([
      "Rate on a 1-10 scale",
      "Write real reviews",
      "Curate lists",
      "Follow your people",
    ]);

    for (const card of cards) {
      const description = card.querySelector("p");
      expect(description?.textContent?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("describes each feature with its own copy", () => {
    render(<FeatureGrid />);

    expect(screen.getByText(/ten points, not five stars/i).closest("li")).toBe(
      screen
        .getByRole("heading", { name: "Rate on a 1-10 scale" })
        .closest("li"),
    );
    expect(screen.getByText(/ranked or unranked/i).closest("li")).toBe(
      screen.getByRole("heading", { name: "Curate lists" }).closest("li"),
    );
  });

  it("renders from local copy without calling the API", () => {
    render(<FeatureGrid />);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

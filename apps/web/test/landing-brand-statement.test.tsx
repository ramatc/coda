// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const { BrandStatement } = await import("../app/_landing/brand-statement");

afterEach(() => {
  cleanup();
});

describe("BrandStatement", () => {
  it("renders the editorial positioning as a labelled region", () => {
    render(<BrandStatement />);

    const region = screen.getByRole("region", {
      name: "Built for the records that stay with you after dark.",
    });
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe(
      "Built for the records that stay with you after dark.",
    );
  });

  it("carries the positioning copy beneath the heading", () => {
    render(<BrandStatement />);

    const region = screen.getByRole("region");
    expect(within(region).getByText("After Hours Archive")).toBeTruthy();
    expect(region.textContent).toContain(
      "Coda is a diary for the albums you return to",
    );
  });

  it("is purely editorial: no links, no anchor id of its own", () => {
    render(<BrandStatement />);

    const region = screen.getByRole("region");
    expect(within(region).queryAllByRole("link")).toHaveLength(0);
    expect(
      ["features", "trending", "reviews", "lists"].includes(region.id),
    ).toBe(false);
  });
});

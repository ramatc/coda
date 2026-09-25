// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const { PublicFooter } = await import("../app/_landing/public-footer");

afterEach(() => {
  cleanup();
});

describe("PublicFooter", () => {
  it("renders the informational link set in order", () => {
    render(<PublicFooter />);

    const footer = screen.getByRole("contentinfo");
    const nav = within(footer).getByRole("navigation", { name: "Footer" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);

    expect(labels).toEqual([
      "About",
      "Community Guidelines",
      "Privacy",
      "Terms",
      "Contact",
      "GitHub",
    ]);
  });

  it("uses placeholder targets for pages that do not exist yet", () => {
    render(<PublicFooter />);

    const nav = screen.getByRole("navigation", { name: "Footer" });
    const hrefs = within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));

    expect(hrefs).toHaveLength(6);
    expect(new Set(hrefs)).toEqual(new Set(["#"]));
  });

  it("carries the brand line and the current year", () => {
    render(<PublicFooter />);

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("Coda Archive")).toBeTruthy();
    expect(footer.textContent).toContain(`© ${new Date().getFullYear()}`);
  });
});

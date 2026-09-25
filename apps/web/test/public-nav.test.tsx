// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { PublicNav } = await import("../app/_landing/public-nav");

afterEach(() => {
  cleanup();
});

/** The mobile menu toggle button. */
function menuButton(): HTMLElement {
  return screen.getByRole("button", { name: /menu/i });
}

describe("PublicNav", () => {
  it("links to the landing page's on-page sections", () => {
    render(<PublicNav />);

    const desktop = screen.getByRole("navigation", { name: "Landing" });
    const links = Array.from(desktop.querySelectorAll("a"));

    expect(links.map((link) => link.textContent)).toEqual([
      "Features",
      "Trending",
      "Reviews",
      "Lists",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#features",
      "#trending",
      "#reviews",
      "#lists",
    ]);
  });

  it("starts with the mobile menu closed", () => {
    render(<PublicNav />);

    const button = menuButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Open menu");
    // aria-controls must resolve even while the panel is closed.
    const controlled = document.getElementById(
      button.getAttribute("aria-controls") ?? "",
    );
    expect(controlled?.hidden).toBe(true);
    expect(
      screen.queryByRole("navigation", { name: "Landing mobile" }),
    ).toBeNull();
  });

  it("opens the mobile menu and wires aria-controls to the revealed panel", () => {
    render(<PublicNav />);

    fireEvent.click(menuButton());

    const button = menuButton();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Close menu");

    const panel = screen.getByRole("navigation", { name: "Landing mobile" });
    expect(panel.id).not.toBe("");
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
    expect(
      Array.from(panel.querySelectorAll("a")).map((a) =>
        a.getAttribute("href"),
      ),
    ).toEqual(["#features", "#trending", "#reviews", "#lists"]);
  });

  it("closes the mobile menu when the toggle is pressed again", () => {
    render(<PublicNav />);

    fireEvent.click(menuButton());
    fireEvent.click(menuButton());

    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("navigation", { name: "Landing mobile" }),
    ).toBeNull();
  });

  it("closes the mobile menu after a section link is followed", () => {
    render(<PublicNav />);

    fireEvent.click(menuButton());
    const panel = screen.getByRole("navigation", { name: "Landing mobile" });
    fireEvent.click(panel.querySelector('a[href="#reviews"]') as HTMLElement);

    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("navigation", { name: "Landing mobile" }),
    ).toBeNull();
  });

  it("closes the mobile menu on Escape and returns focus to the toggle", () => {
    render(<PublicNav />);

    fireEvent.click(menuButton());
    const panel = screen.getByRole("navigation", { name: "Landing mobile" });
    fireEvent.keyDown(panel, { key: "Escape" });

    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(menuButton());
  });

  it("closes the mobile menu on Escape when focus is still on the toggle", () => {
    render(<PublicNav />);

    const button = menuButton();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "Escape" });

    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("navigation", { name: "Landing mobile" }),
    ).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  it("hides the mobile toggle/panel wrapper at md and up so it adds no desktop gap", () => {
    render(<PublicNav />);

    fireEvent.click(menuButton());
    const wrapper = menuButton().parentElement;
    const panel = screen.getByRole("navigation", { name: "Landing mobile" });

    expect(wrapper?.className).toContain("md:hidden");
    expect(wrapper?.contains(panel)).toBe(true);
  });

  it("ignores keys other than Escape while the menu is open", () => {
    render(<PublicNav />);

    fireEvent.click(menuButton());
    const panel = screen.getByRole("navigation", { name: "Landing mobile" });
    fireEvent.keyDown(panel, { key: "Tab" });

    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * Tripwire: the landing renders identically for every visitor, so the hero
 * must never resolve a session. If it ever calls Clerk, the tests fail.
 */
const clerkAuth = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => clerkAuth(),
  currentUser: () => clerkAuth(),
}));

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

const { Hero } = await import("../app/_landing/hero");

afterEach(() => {
  cleanup();
  clerkAuth.mockClear();
});

describe("Hero", () => {
  it("owns the page's single top-level heading, labelling its region", () => {
    render(<Hero />);

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]?.textContent).toBe("Your after-hours music archive.");

    const region = screen.getByRole("region", {
      name: "Your after-hours music archive.",
    });
    expect(region.textContent).toContain(
      "Rate every album on a 1-10 scale, write the review it deserves",
    );
  });

  it("sends the primary call to action to sign-up", () => {
    render(<Hero />);

    const primary = screen.getByRole("link", { name: "Start your archive" });
    expect(primary.getAttribute("href")).toBe("/sign-up");
  });

  it("points the secondary call to action at the on-page trending section", () => {
    render(<Hero />);

    const secondary = screen.getByRole("link", { name: "Explore trending" });
    expect(secondary.getAttribute("href")).toBe("#trending");
  });

  it("exposes exactly the two calls to action, primary first", () => {
    render(<Hero />);

    const region = screen.getByRole("region");
    const hrefs = within(region)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["/sign-up", "#trending"]);
  });

  it("never touches Clerk to render", () => {
    render(<Hero />);

    expect(clerkAuth).not.toHaveBeenCalled();
  });
});

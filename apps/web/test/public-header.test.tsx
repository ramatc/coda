// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * Tripwires: the public header must never resolve a session. If it ever
 * imports Clerk, these mocks record the call and the tests below fail.
 */
const clerkAuth = vi.fn();
const clerkUseUser = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => clerkAuth(),
  currentUser: () => clerkAuth(),
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => clerkUseUser(),
  useAuth: () => clerkUseUser(),
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

const { PublicHeader } = await import("../app/_landing/public-header");

afterEach(() => {
  cleanup();
  clerkAuth.mockClear();
  clerkUseUser.mockClear();
});

describe("PublicHeader", () => {
  it("links the CODA wordmark home", () => {
    render(<PublicHeader />);

    const home = screen.getByRole("link", { name: /CODA/ });
    expect(home.getAttribute("href")).toBe("/");
  });

  it("offers the logged-out calls to action", () => {
    render(<PublicHeader />);

    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/sign-in");
    expect(
      screen.getByRole("link", { name: "Get started" }).getAttribute("href"),
    ).toBe("/sign-up");
  });

  it("includes the on-page section navigation", () => {
    render(<PublicHeader />);

    const header = screen.getByRole("banner");
    expect(
      within(header).getByRole("navigation", { name: "Landing" }),
    ).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "Open menu" }),
    ).toBeTruthy();
  });

  it("renders no session UI: no avatar, profile link, or authenticated CTA", () => {
    render(<PublicHeader />);

    const header = screen.getByRole("banner");
    expect(within(header).queryByTestId("header-avatar")).toBeNull();
    expect(within(header).queryByRole("link", { name: /profile/i })).toBeNull();
    expect(within(header).queryByText("+ LOG")).toBeNull();

    const hrefs = within(header)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/",
      "#features",
      "#trending",
      "#reviews",
      "#lists",
      "/sign-in",
      "/sign-up",
    ]);
    for (const href of hrefs) {
      expect(href).not.toMatch(/^\/(u\/|home|feed|activity|lists)/);
    }
  });

  it("never touches Clerk to render", () => {
    render(<PublicHeader />);

    expect(clerkAuth).not.toHaveBeenCalled();
    expect(clerkUseUser).not.toHaveBeenCalled();
  });
});

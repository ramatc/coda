// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * Tripwire: the closing call to action is the same for every visitor, so it
 * must never resolve a session.
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

const { FinalCta } = await import("../app/_landing/final-cta");

afterEach(() => {
  cleanup();
  clerkAuth.mockClear();
});

describe("FinalCta", () => {
  it("closes the page with a labelled sign-up prompt", () => {
    render(<FinalCta />);

    const region = screen.getByRole("region", {
      name: "Start your archive tonight.",
    });
    expect(within(region).getByRole("heading", { level: 2 }).textContent).toBe(
      "Start your archive tonight.",
    );
  });

  it("sends the primary action to sign-up", () => {
    render(<FinalCta />);

    expect(
      screen
        .getByRole("link", { name: "Create your free account" })
        .getAttribute("href"),
    ).toBe("/sign-up");
  });

  it("offers returning members a way to sign in, after the primary action", () => {
    render(<FinalCta />);

    const region = screen.getByRole("region");
    const links = within(region).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Create your free account",
      "Sign in",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sign-up",
      "/sign-in",
    ]);
  });

  it("never touches Clerk to render", () => {
    render(<FinalCta />);

    expect(clerkAuth).not.toHaveBeenCalled();
  });
});

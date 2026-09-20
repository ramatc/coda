// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

let pathname = "/home";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
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

const { BottomNav } = await import("../app/_shell/bottom-nav");

afterEach(() => {
  cleanup();
});

describe("BottomNav", () => {
  it("maps the five concepts to the confirmed real routes", () => {
    pathname = "/home";
    render(<BottomNav youHref="/u/mati" />);

    expect(screen.getByRole("link", { name: /Home/ })).toHaveProperty(
      "href",
      expect.stringContaining("/home"),
    );
    expect(screen.getByRole("link", { name: /Search/ })).toHaveProperty(
      "href",
      expect.stringContaining("/search"),
    );
    expect(screen.getByRole("link", { name: /Diary/ })).toHaveProperty(
      "href",
      expect.stringContaining("/activity"),
    );
    expect(screen.getByRole("link", { name: /Lists/ })).toHaveProperty(
      "href",
      expect.stringContaining("/lists"),
    );
    expect(screen.getByRole("link", { name: /You/ })).toHaveProperty(
      "href",
      expect.stringContaining("/u/mati"),
    );
  });

  it("marks only the item matching the current path as active", () => {
    pathname = "/home";
    render(<BottomNav youHref="/u/mati" />);

    expect(
      screen.getByRole("link", { name: /Home/ }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: /Search/ })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks nothing active when the current path matches none of the five", () => {
    pathname = "/albums/some-id";
    render(<BottomNav youHref="/u/mati" />);

    for (const name of [/Home/, /Search/, /Diary/, /Lists/, /You/]) {
      expect(
        screen.getByRole("link", { name }).getAttribute("aria-current"),
      ).toBeNull();
    }
  });
});

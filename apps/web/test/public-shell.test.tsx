// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

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

const { PublicShell } = await import("../app/_landing/public-shell");

afterEach(() => {
  cleanup();
});

describe("PublicShell", () => {
  it("renders the public header, the page content, then the footer", () => {
    render(
      <PublicShell>
        <section data-testid="page-content">Landing body</section>
      </PublicShell>,
    );

    const header = screen.getByRole("banner");
    const content = screen.getByTestId("page-content");
    const footer = screen.getByRole("contentinfo");

    expect(content.textContent).toBe("Landing body");
    expect(
      screen.getByRole("link", { name: "Get started" }).getAttribute("href"),
    ).toBe("/sign-up");
    expect(
      screen.getByRole("navigation", { name: "Footer" }).textContent,
    ).toContain("Community Guidelines");

    expect(
      header.compareDocumentPosition(content) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      content.compareDocumentPosition(footer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("wraps the page content in the main landmark, outside header and footer", () => {
    render(
      <PublicShell>
        <p>First block</p>
        <p>Second block</p>
      </PublicShell>,
    );

    const main = screen.getByRole("main");
    expect(main.textContent).toBe("First blockSecond block");
    expect(main.contains(screen.getByRole("banner"))).toBe(false);
    expect(main.contains(screen.getByRole("contentinfo"))).toBe(false);
  });
});

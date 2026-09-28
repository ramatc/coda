// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
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

// The monogram is decorative (`alt=""`) and asserted nowhere, so its double
// renders nothing rather than an unloaded image.
vi.mock("next/image", () => ({
  default: () => null,
}));

// The bell is a client island with its own suite; here it is a sentinel so
// this test pins only WHERE the header mounts it.
vi.mock("../app/_shell/notification-bell", () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));

const { Header } = await import("../app/_shell/header");

afterEach(() => {
  cleanup();
});

describe("Header", () => {
  it("renders the viewer's avatar link and the + LOG action", () => {
    render(<Header youHref="/u/mati" youInitial="M" />);

    expect(
      screen.getByRole("link", { name: "Your profile" }).getAttribute("href"),
    ).toBe("/u/mati");
    expect(screen.getByTestId("header-avatar").textContent).toBe("M");
    expect(
      screen.getByRole("link", { name: "+ LOG" }).getAttribute("href"),
    ).toBe("/search");
  });

  it("mounts the notification bell between + LOG and the avatar", () => {
    render(<Header youHref="/u/mati" youInitial="M" />);

    const log = screen.getByRole("link", { name: "+ LOG" });
    const bell = screen.getByRole("button", { name: "Notifications" });
    const avatar = screen.getByRole("link", { name: "Your profile" });

    expect(
      log.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      bell.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

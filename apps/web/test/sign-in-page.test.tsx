// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * `SignIn` is a framework boundary from Clerk, mocked here the same way
 * `SignInButton` is mocked in `review-sign-in-prompt.test.tsx`: this proves
 * the PAGE hosts Clerk's widget inside the app's own shell, not that Clerk's
 * hosted UI renders correctly (that's Clerk's own test surface, not ours).
 */
vi.mock("@clerk/nextjs", () => ({
  SignIn: () => <div data-testid="clerk-sign-in" />,
}));

const { default: SignInPage } = await import(
  "../app/sign-in/[[...sign-in]]/page"
);

afterEach(() => {
  cleanup();
});

describe("SignInPage", () => {
  it("hosts Clerk's sign-in widget inside the page's main landmark", () => {
    render(<SignInPage />);

    const main = screen.getByRole("main");
    expect(within(main).getByTestId("clerk-sign-in")).not.toBeNull();
  });

  it("renders exactly one instance of the widget", () => {
    render(<SignInPage />);

    expect(screen.getAllByTestId("clerk-sign-in")).toHaveLength(1);
  });
});

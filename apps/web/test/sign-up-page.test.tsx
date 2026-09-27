// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

/**
 * `SignUp` is a framework boundary from Clerk, mocked here the same way
 * `SignInButton` is mocked in `review-sign-in-prompt.test.tsx`: this proves
 * the PAGE hosts Clerk's widget inside the app's own shell, not that Clerk's
 * hosted UI renders correctly (that's Clerk's own test surface, not ours).
 */
vi.mock("@clerk/nextjs", () => ({
  SignUp: () => <div data-testid="clerk-sign-up" />,
}));

const { default: SignUpPage } = await import(
  "../app/sign-up/[[...sign-up]]/page"
);

afterEach(() => {
  cleanup();
});

describe("SignUpPage", () => {
  it("hosts Clerk's sign-up widget inside the page's main landmark", () => {
    render(<SignUpPage />);

    const main = screen.getByRole("main");
    expect(within(main).getByTestId("clerk-sign-up")).not.toBeNull();
  });

  it("renders exactly one instance of the widget", () => {
    render(<SignUpPage />);

    expect(screen.getAllByTestId("clerk-sign-up")).toHaveLength(1);
  });
});

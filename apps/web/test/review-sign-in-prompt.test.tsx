// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { ReviewSignInPrompt } from "../app/reviews/[id]/review-sign-in-prompt";

/**
 * Clerk's `SignInButton` is a framework boundary, mocked here exactly as
 * `@clerk/nextjs` is mocked in the other island tests. The mock re-publishes the
 * props on data attributes so the assertions below can prove WHICH sign-in
 * journey the prompt starts, not merely that something rendered.
 */
vi.mock("@clerk/nextjs", () => ({
  SignInButton: ({
    children,
    forceRedirectUrl,
    mode,
  }: {
    children: ReactNode;
    forceRedirectUrl?: string;
    mode?: string;
  }) => (
    <span
      data-testid="clerk-sign-in-button"
      data-force-redirect-url={forceRedirectUrl}
      data-mode={mode ?? "redirect"}
    >
      {children}
    </span>
  ),
}));

afterEach(() => {
  cleanup();
});

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

describe("ReviewSignInPrompt", () => {
  it("renders its label as a real button inside Clerk's sign-in trigger", () => {
    render(<ReviewSignInPrompt reviewId={REVIEW_ID} label="Sign in to like" />);

    const button = screen.getByRole("button", { name: "Sign in to like" });
    expect(button).not.toBeNull();
    // A real <button> rather than a bare <span>, so the affordance is reachable
    // by keyboard and announced as actionable.
    expect(button.tagName).toBe("BUTTON");
    expect(screen.getByTestId("clerk-sign-in-button")).not.toBeNull();
  });

  it("returns the visitor to the review they were reading", () => {
    render(<ReviewSignInPrompt reviewId={REVIEW_ID} label="Sign in to like" />);

    // Without this the visitor signs in and lands on Clerk's default
    // destination, losing the review that prompted them in the first place.
    expect(
      screen
        .getByTestId("clerk-sign-in-button")
        .getAttribute("data-force-redirect-url"),
    ).toBe(`/reviews/${REVIEW_ID}`);
  });

  it("escapes the review id in the redirect target", () => {
    render(<ReviewSignInPrompt reviewId="not a/uuid" label="Sign in" />);

    expect(
      screen
        .getByTestId("clerk-sign-in-button")
        .getAttribute("data-force-redirect-url"),
    ).toBe("/reviews/not%20a%2Fuuid");
  });

  it("sends the visitor to a full sign-in page rather than a modal", () => {
    render(<ReviewSignInPrompt reviewId={REVIEW_ID} label="Sign in to like" />);

    // Redirect mode is what makes `forceRedirectUrl` meaningful: a modal would
    // leave the viewer on a page whose server-rendered `canInteract` is still
    // false, so the controls would stay dead until a manual reload.
    expect(
      screen.getByTestId("clerk-sign-in-button").getAttribute("data-mode"),
    ).toBe("redirect");
  });

  it("labels each call site differently so the two prompts are distinguishable", () => {
    render(
      <ReviewSignInPrompt reviewId={REVIEW_ID} label="Sign in to comment" />,
    );

    expect(
      screen.getByRole("button", { name: "Sign in to comment" }),
    ).not.toBeNull();
  });
});

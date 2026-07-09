import { describe, expect, it } from "vitest";
import {
  HOME_PATH,
  ONBOARDING_PATH,
  isOnboardingSubmittable,
  resolveOnboardingRedirect,
} from "../lib/onboarding";

/**
 * Pure unit tests for the onboarding gate + submit-gating logic, extracted from
 * the server pages so they run without a request context (same testability
 * pattern as `cors.config.ts` and `middleware.config.ts`). These cover spec
 * scenario "unonboarded user hitting /home is redirected to /onboarding".
 */
describe("resolveOnboardingRedirect", () => {
  it("redirects an unonboarded user off /home to /onboarding", () => {
    expect(resolveOnboardingRedirect({ complete: false }, "/home")).toBe(
      ONBOARDING_PATH,
    );
  });

  it("lets an onboarded user reach /home", () => {
    expect(resolveOnboardingRedirect({ complete: true }, "/home")).toBeNull();
  });

  it("lets an unonboarded user stay on /onboarding (no self-redirect loop)", () => {
    expect(
      resolveOnboardingRedirect({ complete: false }, "/onboarding"),
    ).toBeNull();
  });

  it("bounces an already-onboarded user off /onboarding to /home", () => {
    expect(resolveOnboardingRedirect({ complete: true }, "/onboarding")).toBe(
      HOME_PATH,
    );
  });
});

describe("isOnboardingSubmittable", () => {
  it("requires at least 3 genres and 1 artist", () => {
    expect(isOnboardingSubmittable(3, 1, 0)).toBe(true);
    expect(isOnboardingSubmittable(2, 1, 0)).toBe(false);
    expect(isOnboardingSubmittable(3, 0, 0)).toBe(false);
  });

  it("allows up to 4 albums but not more", () => {
    expect(isOnboardingSubmittable(3, 1, 4)).toBe(true);
    expect(isOnboardingSubmittable(3, 1, 5)).toBe(false);
  });
});

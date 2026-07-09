import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOME_PATH,
  ONBOARDING_PATH,
  fetchGenres,
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

  it("does not false-match a route that merely starts with the onboarding path", () => {
    // `/onboardingsurvey` is a different route, not `/onboarding` itself — a
    // naive `startsWith` prefix check would incorrectly treat this as "on
    // onboarding" and let an unonboarded user through.
    expect(
      resolveOnboardingRedirect({ complete: false }, "/onboardingsurvey"),
    ).toBe(ONBOARDING_PATH);
  });

  it("still matches a nested onboarding sub-route", () => {
    expect(
      resolveOnboardingRedirect({ complete: false }, "/onboarding/step-2"),
    ).toBeNull();
  });

  it("redirects an unonboarded user off /dashboard to /onboarding", () => {
    expect(resolveOnboardingRedirect({ complete: false }, "/dashboard")).toBe(
      ONBOARDING_PATH,
    );
  });

  it("redirects an unonboarded user off /u/[username] to /onboarding", () => {
    expect(
      resolveOnboardingRedirect({ complete: false }, "/u/someone"),
    ).toBe(ONBOARDING_PATH);
  });
});

describe("fetchGenres", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails safe to an empty list on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(fetchGenres(null)).resolves.toEqual([]);
  });

  it("fails safe to an empty list on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false } as Response),
    );

    await expect(fetchGenres("token")).resolves.toEqual([]);
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

  it("allows up to MAX_ARTISTS artists but not more", () => {
    expect(isOnboardingSubmittable(3, 20, 0)).toBe(true);
    expect(isOnboardingSubmittable(3, 21, 0)).toBe(false);
  });
});

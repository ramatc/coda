import { describe, expect, it } from "vitest";
import { createRouteMatcher } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { config } from "../middleware";
import { protectedRoutePatterns } from "../middleware.config";

/** Runs a path through the same Clerk matcher `middleware.ts` builds. */
const matchesProtected = createRouteMatcher([...protectedRoutePatterns]);
const isProtectedPath = (path: string) =>
  matchesProtected(new NextRequest(`http://localhost${path}`));

/**
 * Static/structural assertion of the Clerk middleware config. This does NOT
 * spin up a live Clerk session; it verifies the routing surface: the dashboard
 * is the protected route, and the real exported Next matcher covers API routes
 * while skipping internals/static assets.
 */
describe("middleware config", () => {
  it("protects the dashboard route", () => {
    expect(protectedRoutePatterns).toContain("/dashboard(.*)");
  });

  it("protects the profile routes at /u/[username]", () => {
    expect(protectedRoutePatterns).toContain("/u(.*)");
  });

  it("protects the onboarding and home routes (PR4)", () => {
    expect(protectedRoutePatterns).toContain("/onboarding(.*)");
    expect(protectedRoutePatterns).toContain("/home(.*)");
  });

  it("protects the discover/search route (PR7)", () => {
    expect(protectedRoutePatterns).toContain("/search(.*)");
  });

  it("leaves the album detail route PUBLIC so album pages can be indexed", () => {
    expect(
      isProtectedPath("/albums/0f6c3c1e-1111-4111-8111-111111111111"),
    ).toBe(false);
  });

  it("protects the personal activity route (PR10)", () => {
    expect(protectedRoutePatterns).toContain("/activity(.*)");
  });

  it("protects the followed-activity feed route (PR4)", () => {
    expect(protectedRoutePatterns).toContain("/feed(.*)");
  });

  it("protects the viewer's own lists and the create-list form", () => {
    expect(isProtectedPath("/lists")).toBe(true);
    expect(isProtectedPath("/lists/new")).toBe(true);
  });

  it("leaves list detail pages PUBLIC (private lists are a 404 from the API)", () => {
    expect(isProtectedPath("/lists/0f6c3c1e-1111-4111-8111-111111111111")).toBe(
      false,
    );
  });

  it("keeps every other app route protected", () => {
    for (const path of [
      "/dashboard",
      "/u/curator",
      "/onboarding",
      "/home",
      "/search",
      "/activity",
      "/feed",
    ]) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });

  it("leaves the review detail route PUBLIC (Fase 2 slice 3)", () => {
    /** Every protected pattern that would cover `prefix`. */
    const guarding = (prefix: string) =>
      protectedRoutePatterns.filter((route) => route.startsWith(prefix));

    // The predicate DOES find a route when one is protected, so the empty
    // result below is a real absence rather than a broken matcher.
    expect(guarding("/lists")).toEqual(["/lists", "/lists/new(.*)"]);

    // `/reviews/[id]` is an anonymously-readable page: it renders
    // for logged-out visitors, and the API's `GET /reviews/:id` answers them 200
    // instead of 401. Adding `/reviews(.*)` here would send every one of them to
    // sign-in before the page ever ran — a silent regression the page itself
    // cannot detect. This assertion is the tripwire.
    expect(guarding("/reviews")).toEqual([]);
  });

  it("leaves the in-app Clerk auth routes PUBLIC", () => {
    /**
     * Every pattern here is a literal prefix followed by `(.*)` (see the
     * patterns above), so a real match is "the path starts with the prefix
     * before `(.*)`" — not merely "some pattern string starts with the same
     * characters" (which `guarding` above checks for `/lists` vs `/reviews`).
     * `/sign-in` and `/sign-up` must never redirect through `auth.protect()`,
     * or a signed-out visitor could never reach the pages that sign them in.
     */
    const isProtected = (path: string) =>
      protectedRoutePatterns.some((pattern) =>
        path.startsWith(pattern.replace("(.*)", "")),
      );

    expect(isProtected("/sign-in")).toBe(false);
    expect(isProtected("/sign-up")).toBe(false);
    // Clerk appends its own sub-paths (multi-factor, verification, …) under
    // the catch-all route; those must stay public too.
    expect(isProtected("/sign-in/factor-one")).toBe(false);
    expect(isProtected("/sign-up/verify-email-address")).toBe(false);
  });

  it("exposes a Next matcher that covers API routes", () => {
    expect(Array.isArray(config.matcher)).toBe(true);
    expect(config.matcher).toContain("/(api|trpc)(.*)");
  });

  it("skips Next internals in the matcher", () => {
    const skipsInternals = config.matcher.some((pattern) =>
      pattern.includes("_next"),
    );
    expect(skipsInternals).toBe(true);
  });
});

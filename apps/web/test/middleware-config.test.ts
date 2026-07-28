import { describe, expect, it } from "vitest";
import { config } from "../middleware";
import { protectedRoutePatterns } from "../middleware.config";

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

  it("protects the album detail route (PR9)", () => {
    expect(protectedRoutePatterns).toContain("/albums(.*)");
  });

  it("protects the personal activity route (PR10)", () => {
    expect(protectedRoutePatterns).toContain("/activity(.*)");
  });

  it("protects the followed-activity feed route (PR4)", () => {
    expect(protectedRoutePatterns).toContain("/feed(.*)");
  });

  it("protects the list routes (Fase 2 slice 2 PR4)", () => {
    expect(protectedRoutePatterns).toContain("/lists(.*)");
  });

  it("leaves the review detail route PUBLIC (Fase 2 slice 3)", () => {
    /** Every protected pattern that would cover `prefix`. */
    const guarding = (prefix: string) =>
      protectedRoutePatterns.filter((route) => route.startsWith(prefix));

    // The predicate DOES find a route when one is protected, so the empty
    // result below is a real absence rather than a broken matcher.
    expect(guarding("/lists")).toEqual(["/lists(.*)"]);

    // `/reviews/[id]` is the app's only anonymously-readable page: it renders
    // for logged-out visitors, and the API's `GET /reviews/:id` answers them 200
    // instead of 401. Adding `/reviews(.*)` here would send every one of them to
    // sign-in before the page ever ran — a silent regression the page itself
    // cannot detect. This assertion is the tripwire.
    expect(guarding("/reviews")).toEqual([]);
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

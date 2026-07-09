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

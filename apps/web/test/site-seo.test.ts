import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "../app/robots";
import { protectedRoutePatterns } from "../middleware.config";
import { getSiteUrl } from "../lib/site-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSiteUrl", () => {
  it("reads NEXT_PUBLIC_SITE_URL without a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://coda.example/");

    expect(getSiteUrl()).toBe("https://coda.example");
  });

  it("falls back to the local web port when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);

    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  it("assumes https for a value without a scheme instead of crashing every page", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "coda.example");

    expect(getSiteUrl()).toBe("https://coda.example");
  });

  it("falls back to the local web port for a value that is not a URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://exa mple");

    expect(getSiteUrl()).toBe("http://localhost:3000");
  });
});

describe("robots", () => {
  it("lets crawlers in and keeps them out of signed-in surfaces", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;

    expect(rule?.userAgent).toBe("*");
    expect(rule?.allow).toBe("/");
    expect(rule?.disallow).toEqual(
      expect.arrayContaining([
        "/dashboard",
        "/u",
        "/onboarding",
        "/home",
        "/search",
        "/activity",
        "/feed",
        "/lists$",
        "/lists/new",
        "/sign-in",
        "/sign-up",
      ]),
    );
  });

  it("disallows every route the middleware protects, so a new one is never forgotten", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const disallow = ([] as string[]).concat(rule?.disallow ?? []);

    for (const pattern of protectedRoutePatterns) {
      const prefix = pattern.replace("(.*)", "");
      expect(disallow.some((path) => path.replace(/\$$/, "") === prefix)).toBe(
        true,
      );
    }
  });

  it("points crawlers at the sitemap on the public site URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://coda.example");

    expect(robots().sitemap).toBe("https://coda.example/sitemap.xml");
  });

  it("never disallows the public album and list detail pages", () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const disallow = ([] as string[]).concat(rule?.disallow ?? []);

    for (const path of disallow) {
      expect("/albums/some-id".startsWith(path)).toBe(false);
      // `$` anchors the rule to the exact path, so `/lists$` spares `/lists/<id>`.
      if (!path.endsWith("$")) {
        expect("/lists/some-id".startsWith(path)).toBe(false);
      }
    }
  });
});

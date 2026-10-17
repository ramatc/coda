import type { MetadataRoute } from "next";

/**
 * `robots.txt`: crawlers may index the public pages (landing, album, list and
 * review detail) and are kept out of the signed-in surfaces that
 * `middleware.config.ts` protects. `/lists$` is anchored so the viewer's own
 * lists stay out while public list pages at `/lists/<id>` stay in.
 *
 * No `sitemap` entry yet: listing every album and public list needs a new API
 * endpoint, tracked as a follow-up.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/dashboard",
        "/u/",
        "/onboarding",
        "/home",
        "/search",
        "/activity",
        "/feed",
        "/lists$",
        "/lists/new",
        "/sign-in",
        "/sign-up",
      ],
    },
  };
}

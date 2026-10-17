import type { MetadataRoute } from "next";
import { protectedRoutePatterns } from "../middleware.config";

/**
 * A robots.txt path for one middleware pattern: `/feed(.*)` becomes the prefix
 * `/feed`, and an exact pattern like `/lists` is anchored as `/lists$` so the
 * viewer's own lists stay out while public list pages at `/lists/<id>` stay in.
 */
function toRobotsPath(pattern: string): string {
  return pattern.endsWith("(.*)")
    ? pattern.slice(0, -"(.*)".length)
    : `${pattern}$`;
}

/**
 * `robots.txt`: crawlers may index the public pages (landing, album, list and
 * review detail) and are kept out of every signed-in surface, derived from
 * `protectedRoutePatterns` so a newly protected route is never forgotten here,
 * plus the in-app sign-in and sign-up pages.
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
        ...protectedRoutePatterns.map(toRobotsPath),
        "/sign-in",
        "/sign-up",
      ],
    },
  };
}

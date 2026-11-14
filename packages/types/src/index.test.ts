import { describe, expect, it } from "vitest";
import {
  MAX_ALBUMS,
  MAX_ARTISTS,
  MIN_ARTISTS,
  MIN_GENRES,
  emailSchema,
  healthStatusSchema,
  paginationParamsSchema,
  sitemapEntriesSchema,
} from "./index";

// Smoke test: proves the shared Vitest preset (@coda/config/vitest/base.js)
// is wired and that @coda/types schemas are exercisable across the monorepo.
describe("@coda/types shared schemas", () => {
  it("validates a well-formed email", () => {
    expect(emailSchema.parse("dev@coda.app")).toBe("dev@coda.app");
  });

  it("rejects an invalid email", () => {
    expect(() => emailSchema.parse("not-an-email")).toThrow();
  });

  it("applies the default pagination limit", () => {
    expect(paginationParamsSchema.parse({})).toEqual({ limit: 20 });
  });

  it("accepts a valid health status payload", () => {
    expect(healthStatusSchema.parse({ status: "ok", uptime: 1.5 })).toEqual({
      status: "ok",
      uptime: 1.5,
    });
  });

  it("accepts a sitemap payload of ids and ISO timestamps", () => {
    const payload = {
      albums: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          updatedAt: "2026-10-01T08:00:00.000Z",
        },
      ],
      lists: [],
    };

    expect(sitemapEntriesSchema.parse(payload)).toEqual(payload);
  });

  it("rejects a sitemap entry whose id is not a UUID", () => {
    expect(() =>
      sitemapEntriesSchema.parse({
        albums: [{ id: "../admin", updatedAt: "2026-10-01T08:00:00.000Z" }],
        lists: [],
      }),
    ).toThrow();
  });

  it("exposes consistent onboarding capture bounds", () => {
    // Single source of truth shared by @coda/api and @coda/web — a
    // regression here would silently desync server enforcement from the
    // client's step-gating UI.
    expect(MIN_GENRES).toBe(3);
    expect(MIN_ARTISTS).toBe(1);
    expect(MAX_ARTISTS).toBeGreaterThanOrEqual(MIN_ARTISTS);
    expect(MAX_ALBUMS).toBe(4);
  });
});

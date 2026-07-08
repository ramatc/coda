import { describe, expect, it } from "vitest";
import {
  emailSchema,
  healthStatusSchema,
  paginationParamsSchema,
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
});

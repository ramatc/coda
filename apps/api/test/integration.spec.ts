import { describe, expect, it } from "vitest";
import { isThrowawayDatabase } from "./integration.js";

const url = (database: string) =>
  `postgresql://coda:coda@localhost:5432/${database}?schema=public`;

describe("isThrowawayDatabase", () => {
  it("trusts CI, whose Postgres is an ephemeral service container", () => {
    expect(isThrowawayDatabase(url("coda"), { CI: "true" })).toBe(true);
  });

  it("accepts databases named as test or scratch copies", () => {
    expect(isThrowawayDatabase(url("coda_test"), {})).toBe(true);
    expect(isThrowawayDatabase(url("coda_scratch"), {})).toBe(true);
    expect(isThrowawayDatabase(url("scratch-db"), {})).toBe(true);
  });

  it("refuses the everyday development database", () => {
    expect(isThrowawayDatabase(url("coda"), {})).toBe(false);
    expect(isThrowawayDatabase(url("coda"), { CI: "false" })).toBe(false);
  });

  it("matches whole name segments only, not substrings", () => {
    expect(isThrowawayDatabase(url("contest"), {})).toBe(false);
    expect(isThrowawayDatabase(url("attestations"), {})).toBe(false);
  });

  it("refuses when the database cannot be identified", () => {
    expect(isThrowawayDatabase(undefined, {})).toBe(false);
    expect(isThrowawayDatabase("not a url", {})).toBe(false);
    expect(
      isThrowawayDatabase("postgresql://coda:coda@localhost:5432/", {}),
    ).toBe(false);
  });
});

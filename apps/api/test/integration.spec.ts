import { afterEach, describe, expect, it, vi } from "vitest";
import { isThrowawayDatabase } from "./integration.js";

const url = (database: string) =>
  `postgresql://coda:coda@localhost:5432/${database}?schema=public`;

describe("isThrowawayDatabase", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never trusts the CI flag, since shells and tools export it too", () => {
    vi.stubEnv("CI", "true");

    expect(isThrowawayDatabase(url("coda"))).toBe(false);
    expect(isThrowawayDatabase(url("coda_test"))).toBe(true);
  });

  it("accepts databases with a test or scratch name segment", () => {
    expect(isThrowawayDatabase(url("coda_test"))).toBe(true);
    expect(isThrowawayDatabase(url("coda_scratch"))).toBe(true);
    expect(isThrowawayDatabase(url("scratch-db"))).toBe(true);
  });

  it("refuses the everyday development database", () => {
    expect(isThrowawayDatabase(url("coda"))).toBe(false);
  });

  it("matches whole name segments only, not substrings", () => {
    expect(isThrowawayDatabase(url("contest"))).toBe(false);
    expect(isThrowawayDatabase(url("attestations"))).toBe(false);
  });

  it("refuses when the database cannot be identified", () => {
    expect(isThrowawayDatabase(undefined)).toBe(false);
    expect(isThrowawayDatabase("not a url")).toBe(false);
    expect(isThrowawayDatabase("postgresql://coda:coda@localhost:5432/")).toBe(
      false,
    );
  });
});

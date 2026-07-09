import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the `completeOnboarding` Server Action's error-message
 * surfacing. The API has no global exception filter, so an uncaught error
 * (a Prisma error, a rethrown `NotFoundException`, etc.) becomes Nest's
 * default `{statusCode: 500, message: "Internal server error"}` body — that
 * literal string must never reach the user. Only 4xx (client-error) bodies
 * are trusted to carry a user-facing `message`.
 */
import { completeOnboarding } from "../app/onboarding/actions";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn().mockResolvedValue({
    getToken: vi.fn().mockResolvedValue("test-token"),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ARGS = { genreSlugs: [], artistIds: [], albumIds: [] };

describe("completeOnboarding", () => {
  it("surfaces a 400 validation message from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          message: "Select at least 3 genres to complete onboarding.",
        }),
      }),
    );

    await expect(completeOnboarding(ARGS)).resolves.toEqual({
      ok: false,
      error: "Select at least 3 genres to complete onboarding.",
    });
  });

  it("surfaces a 409 conflict message from the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          message: "Your onboarding preferences conflicted with a concurrent update. Please retry.",
        }),
      }),
    );

    await expect(completeOnboarding(ARGS)).resolves.toEqual({
      ok: false,
      error: "Your onboarding preferences conflicted with a concurrent update. Please retry.",
    });
  });

  it("does NOT surface a 500 response's message, even a literal 'Internal server error'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({
          statusCode: 500,
          message: "Internal server error",
        }),
      }),
    );

    await expect(completeOnboarding(ARGS)).resolves.toEqual({
      ok: false,
      error: "Could not save your onboarding. Please retry.",
    });
  });

  it("falls back to the friendly message on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(completeOnboarding(ARGS)).resolves.toEqual({
      ok: false,
      error: "Could not save your onboarding. Please retry.",
    });
  });
});

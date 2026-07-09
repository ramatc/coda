import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingController } from "../src/onboarding/onboarding.controller.js";
import type { OnboardingService } from "../src/onboarding/onboarding.service.js";

/**
 * Unit tests for {@link OnboardingController}'s query normalization. Express
 * parses a repeated `?q=` query param as `string[]`, not `string` — these
 * prove the controller coerces that shape to a single string before it
 * reaches {@link OnboardingService}, instead of throwing.
 */
describe("OnboardingController", () => {
  let searchArtists: ReturnType<typeof vi.fn>;
  let searchAlbums: ReturnType<typeof vi.fn>;
  let controller: OnboardingController;

  beforeEach(() => {
    searchArtists = vi.fn().mockResolvedValue([]);
    searchAlbums = vi.fn().mockResolvedValue([]);
    const onboarding = {
      searchArtists,
      searchAlbums,
    } as unknown as OnboardingService;
    controller = new OnboardingController(onboarding);
  });

  it("coerces a repeated ?q= query param (string[]) to its first string value for artists", async () => {
    await controller.searchArtists(["radiohead", "portishead"]);
    expect(searchArtists).toHaveBeenCalledWith("radiohead");
  });

  it("coerces a repeated ?q= query param (string[]) to its first string value for albums", async () => {
    await controller.searchAlbums(["ok computer", "in rainbows"]);
    expect(searchAlbums).toHaveBeenCalledWith("ok computer");
  });

  it("falls back to an empty string for a non-string, non-array query value", async () => {
    await controller.searchArtists(42);
    expect(searchArtists).toHaveBeenCalledWith("");
  });

  it("passes a plain string query through unchanged", async () => {
    await controller.searchArtists("radiohead");
    expect(searchArtists).toHaveBeenCalledWith("radiohead");
  });
});

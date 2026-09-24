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
  let suggestArtists: ReturnType<typeof vi.fn>;
  let suggestAlbums: ReturnType<typeof vi.fn>;
  let controller: OnboardingController;

  beforeEach(() => {
    searchArtists = vi.fn().mockResolvedValue([]);
    searchAlbums = vi.fn().mockResolvedValue([]);
    suggestArtists = vi.fn().mockResolvedValue([]);
    suggestAlbums = vi.fn().mockResolvedValue([]);
    const onboarding = {
      searchArtists,
      searchAlbums,
      suggestArtists,
      suggestAlbums,
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

  it("falls back to an empty string when the array's first element is not a string", async () => {
    await controller.searchArtists([42, "x"]);
    expect(searchArtists).toHaveBeenCalledWith("");
  });

  it("falls back to an empty string for an empty array", async () => {
    await controller.searchArtists([]);
    expect(searchArtists).toHaveBeenCalledWith("");
  });

  it("splits a comma-separated ?genres= param and forwards the slugs for suggested artists", async () => {
    await controller.suggestArtists("rock, jazz ,electronic");
    expect(suggestArtists).toHaveBeenCalledWith(["rock", "jazz", "electronic"]);
  });

  it("splits a comma-separated ?genres= param and forwards the slugs for suggested albums", async () => {
    await controller.suggestAlbums("rock,jazz");
    expect(suggestAlbums).toHaveBeenCalledWith(["rock", "jazz"]);
  });

  it("coerces a repeated ?genres= query param (string[]) to its first value before splitting", async () => {
    await controller.suggestArtists(["rock,jazz", "pop"]);
    expect(suggestArtists).toHaveBeenCalledWith(["rock", "jazz"]);
  });

  it("drops empty segments from a trailing/leading/double comma", async () => {
    await controller.suggestAlbums(",rock,,jazz,");
    expect(suggestAlbums).toHaveBeenCalledWith(["rock", "jazz"]);
  });

  it("forwards an empty slug list for a missing ?genres= param", async () => {
    await controller.suggestArtists(undefined);
    expect(suggestArtists).toHaveBeenCalledWith([]);
  });

  it("forwards an empty slug list for a non-string, non-array ?genres= value", async () => {
    await controller.suggestAlbums(42);
    expect(suggestAlbums).toHaveBeenCalledWith([]);
  });
});

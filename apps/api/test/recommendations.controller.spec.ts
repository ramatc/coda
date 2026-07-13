import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecommendationStatus } from "@coda/db";
import { RecommendationsController } from "../src/recommendations/recommendations.controller.js";
import type { RecommendationsService } from "../src/recommendations/recommendations.service.js";

const REC_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

/**
 * Unit tests for {@link RecommendationsController}: a thin pass-through to
 * {@link RecommendationsService} (domain logic covered in the service spec).
 * These prove it forwards the verified Clerk `sub` and the `:id` path param.
 */
describe("RecommendationsController", () => {
  let getRecommendations: ReturnType<typeof vi.fn>;
  let dismiss: ReturnType<typeof vi.fn>;
  let controller: RecommendationsController;

  beforeEach(() => {
    getRecommendations = vi.fn().mockResolvedValue([]);
    dismiss = vi
      .fn()
      .mockResolvedValue({ id: REC_ID, status: RecommendationStatus.DISMISSED });
    const service = {
      getRecommendations,
      dismiss,
    } as unknown as RecommendationsService;
    controller = new RecommendationsController(service);
  });

  it("forwards the list request with the caller's id", async () => {
    await controller.getRecommendations("clerk_1");
    expect(getRecommendations).toHaveBeenCalledWith("clerk_1");
  });

  it("forwards the dismiss with the caller's id and the recommendation id", async () => {
    const result = await controller.dismiss("clerk_1", REC_ID);
    expect(dismiss).toHaveBeenCalledWith("clerk_1", REC_ID);
    expect(result).toEqual({ id: REC_ID, status: RecommendationStatus.DISMISSED });
  });
});

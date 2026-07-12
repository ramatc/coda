import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityController } from "../src/activity/activity.controller.js";
import type { ActivityService } from "../src/activity/activity.service.js";

/**
 * Unit test for {@link ActivityController}: it is a thin pass-through to
 * {@link ActivityService} (the domain logic is covered in
 * `activity.service.spec.ts`). Proves `GET /me/activity` forwards the
 * `ClerkGuard`-verified `@CurrentUser("sub")` and the `cursor`/`limit` query
 * params exactly as received.
 */
describe("ActivityController", () => {
  let getOwnActivity: ReturnType<typeof vi.fn>;
  let controller: ActivityController;

  beforeEach(() => {
    getOwnActivity = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    const service = { getOwnActivity } as unknown as ActivityService;
    controller = new ActivityController(service);
  });

  it("forwards the caller's id with the cursor and limit query params", async () => {
    await controller.getOwnActivity("clerk_1", "cursor-1", "10");
    expect(getOwnActivity).toHaveBeenCalledWith("clerk_1", {
      cursor: "cursor-1",
      limit: "10",
    });
  });

  it("forwards undefined query params when omitted", async () => {
    await controller.getOwnActivity("clerk_1");
    expect(getOwnActivity).toHaveBeenCalledWith("clerk_1", {
      cursor: undefined,
      limit: undefined,
    });
  });
});

import { describe, expect, it } from "vitest";
import { Job } from "bullmq";
import {
  albumJobId,
  enrichJobId,
  pageJobId,
} from "../src/catalog-import/catalog-import.constants.js";
import { searchAlbumSyncJobId } from "../src/search/search.constants.js";
import { recoGenerationJobId } from "../src/recommendations/recommendations.constants.js";

/**
 * BullMQ rejects a custom `jobId` containing `:` (unless it splits into exactly
 * three parts, a legacy repeatable-job format) with "Custom Id cannot contain
 * :". The rejection happens inside `queue.add()`, so a bad id silently drops
 * every enqueue that uses it. Each deterministic id helper is run through
 * BullMQ's own `validateOptions` — the exact check `queue.add()` performs —
 * instead of re-implementing the rule here.
 */
function validateJobId(jobId: string): void {
  // Skip the constructor (it wires Redis scripts off a live queue);
  // `validateOptions` only reads `this.opts`.
  const job = Object.assign(Object.create(Job.prototype) as Job, {
    opts: { jobId },
  });
  (job as unknown as { validateOptions(data: string): void }).validateOptions(
    "{}",
  );
}

const SPOTIFY_ID = "4aawyAB9vmqN3uQ7FjRGTy";
const USER_ID = "3f0b0c36-1d6b-4a8e-9a57-0d2f6d3f5c11";

describe("deterministic BullMQ job ids", () => {
  it.each([
    ["albumJobId", albumJobId(SPOTIFY_ID)],
    ["pageJobId", pageJobId(0)],
    ["pageJobId (later page)", pageJobId(150)],
    ["enrichJobId", enrichJobId(SPOTIFY_ID)],
    ["searchAlbumSyncJobId", searchAlbumSyncJobId(SPOTIFY_ID)],
    ["recoGenerationJobId", recoGenerationJobId(USER_ID)],
  ])("%s is accepted by BullMQ", (_name, jobId) => {
    expect(() => validateJobId(jobId)).not.toThrow();
  });

  it("the validator itself rejects a colon id (guards against a no-op check)", () => {
    expect(() => validateJobId("album:x")).toThrow("Custom Id cannot contain :");
  });

  it("keeps ids distinct per queue key", () => {
    const ids = [
      albumJobId(SPOTIFY_ID),
      enrichJobId(SPOTIFY_ID),
      searchAlbumSyncJobId(SPOTIFY_ID),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";

// In-memory ioredis stand-in: the store's cursor semantics (get/set/clear +
// numeric parsing) are proven without a live Redis, matching the no-infra
// sandbox convention.
vi.mock("ioredis", () => {
  class Redis {
    private readonly data = new Map<string, string>();
    on(): this {
      return this;
    }
    async get(key: string): Promise<string | null> {
      return this.data.has(key) ? (this.data.get(key) as string) : null;
    }
    async set(key: string, value: string): Promise<"OK"> {
      this.data.set(key, value);
      return "OK";
    }
    async del(key: string): Promise<number> {
      return this.data.delete(key) ? 1 : 0;
    }
    async quit(): Promise<"OK"> {
      return "OK";
    }
  }
  return { Redis, default: Redis };
});

const { SpotifyCheckpointStore } = await import(
  "../src/catalog-import/spotify-checkpoint.store.js"
);

function fakeConfig(): ConfigService {
  return {
    get: (key: string) =>
      key === "REDIS_URL" ? "redis://localhost:6379" : undefined,
  } as unknown as ConfigService;
}

describe("SpotifyCheckpointStore", () => {
  let store: InstanceType<typeof SpotifyCheckpointStore>;

  beforeEach(() => {
    store = new SpotifyCheckpointStore(fakeConfig());
  });

  it("returns null before any checkpoint is written", async () => {
    expect(await store.get()).toBeNull();
  });

  it("persists and reads back the resume offset", async () => {
    await store.set(150);
    expect(await store.get()).toBe(150);
  });

  it("clears the checkpoint (resume from scratch after completion)", async () => {
    await store.set(80);
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});

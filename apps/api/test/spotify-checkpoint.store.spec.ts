import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";

// In-memory ioredis stand-in: the store's cursor semantics (get/set/clear +
// numeric parsing) are proven without a live Redis, matching the no-infra
// sandbox convention. `set` honors `NX`/`PX` (judgment-day issue #8) so the
// running-lock's SET-NX-if-absent semantics are exercised for real, and
// `eval` emulates the atomic "release iff still the owner" Lua script
// `releaseRunningLock` uses (judgment-day issue #2) closely enough to prove
// the ownership-token contract without a real Redis `EVAL`.
vi.mock("ioredis", () => {
  class Redis {
    private readonly data = new Map<string, string>();
    on(): this {
      return this;
    }
    async get(key: string): Promise<string | null> {
      return this.data.has(key) ? (this.data.get(key) as string) : null;
    }
    async set(
      key: string,
      value: string,
      ...args: unknown[]
    ): Promise<"OK" | null> {
      const nx = args.includes("NX");
      if (nx && this.data.has(key)) {
        return null;
      }
      this.data.set(key, value);
      return "OK";
    }
    async del(key: string): Promise<number> {
      return this.data.delete(key) ? 1 : 0;
    }
    async eval(
      _script: string,
      _numKeys: number,
      key: string,
      token: string,
    ): Promise<number> {
      if (this.data.get(key) === token) {
        this.data.delete(key);
        return 1;
      }
      return 0;
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

  describe("running lock (judgment-day issue #2 ownership token)", () => {
    it("acquires the lock and returns a unique token", async () => {
      const token = await store.tryAcquireRunningLock();
      expect(token).toEqual(expect.any(String));
    });

    it("refuses a second acquire while the lock is held (SET NX semantics)", async () => {
      await store.tryAcquireRunningLock();
      expect(await store.tryAcquireRunningLock()).toBeNull();
    });

    it("releases the lock when the token matches its current owner", async () => {
      const token = await store.tryAcquireRunningLock();
      await store.releaseRunningLock(token!);

      // Lock is free again — a subsequent acquire succeeds.
      expect(await store.tryAcquireRunningLock()).not.toBeNull();
    });

    it("does NOT release the lock when the token doesn't match (judgment-day issue #2)", async () => {
      await store.tryAcquireRunningLock();

      // A release with a foreign/stale token must be a no-op: it must NOT
      // delete another run's still-valid lock.
      await store.releaseRunningLock("some-other-runs-token");

      expect(await store.tryAcquireRunningLock()).toBeNull();
    });

    it("resolves true when the release actually deleted the lock (judgment-day issue #4, Round 3)", async () => {
      const token = await store.tryAcquireRunningLock();
      await expect(store.releaseRunningLock(token!)).resolves.toBe(true);
    });

    it("resolves false when the release is a no-op — TTL already gone or owned by a newer run (judgment-day issue #4, Round 3)", async () => {
      await store.tryAcquireRunningLock();
      await expect(
        store.releaseRunningLock("some-other-runs-token"),
      ).resolves.toBe(false);
    });
  });

  describe("lockSupport (judgment-day issue #6, Round 3)", () => {
    it("exposes both tryAcquireRunningLock and releaseRunningLock together, wired to the same lock", async () => {
      expect(store.lockSupport).toBeDefined();

      const token = await store.lockSupport.tryAcquireRunningLock();
      expect(token).toEqual(expect.any(String));

      // Wired to the SAME underlying lock as the top-level methods.
      expect(await store.tryAcquireRunningLock()).toBeNull();

      await expect(store.lockSupport.releaseRunningLock(token!)).resolves.toBe(
        true,
      );
      expect(await store.tryAcquireRunningLock()).not.toBeNull();
    });
  });
});

import { describe, expect, it } from "vitest";
import { resolveSingleton, type ClientContainer } from "./singleton";

interface FakeClient {
  id: number;
}

describe("resolveSingleton", () => {
  it("creates an instance via the factory when the container is empty", () => {
    const container: ClientContainer<FakeClient> = {};
    let calls = 0;

    const instance = resolveSingleton(container, () => ({ id: ++calls }), "development");

    expect(instance).toEqual({ id: 1 });
    expect(calls).toBe(1);
  });

  it("reuses the cached instance across calls in non-production", () => {
    const container: ClientContainer<FakeClient> = {};
    let calls = 0;
    const factory = (): FakeClient => ({ id: ++calls });

    const first = resolveSingleton(container, factory, "development");
    const second = resolveSingleton(container, factory, "development");

    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it("caches on the container when NODE_ENV is undefined (treated as non-production)", () => {
    const container: ClientContainer<FakeClient> = {};

    resolveSingleton(container, () => ({ id: 1 }), undefined);

    expect(container.client).toEqual({ id: 1 });
  });

  it("never caches on the container in production", () => {
    const container: ClientContainer<FakeClient> = {};
    let calls = 0;
    const factory = (): FakeClient => ({ id: ++calls });

    const first = resolveSingleton(container, factory, "production");
    const second = resolveSingleton(container, factory, "production");

    expect(container.client).toBeUndefined();
    expect(first).toEqual({ id: 1 });
    expect(second).toEqual({ id: 2 });
    expect(calls).toBe(2);
  });
});

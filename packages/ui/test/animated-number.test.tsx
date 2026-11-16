// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { AnimatedNumber } from "../src/components/animated-number";

let frameCallbacks: FrameRequestCallback[] = [];
let now = 0;

function mockMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("reduce") ? reduced : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

/** Advances the fake clock and flushes every queued animation frame. */
function advance(ms: number) {
  now += ms;
  const pending = frameCallbacks;
  frameCallbacks = [];
  act(() => {
    for (const callback of pending) {
      callback(now);
    }
  });
}

beforeEach(() => {
  now = 0;
  frameCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnimatedNumber", () => {
  it("renders the first value immediately, without animating", () => {
    mockMotion(false);
    render(<AnimatedNumber value={42} />);

    expect(screen.getByTestId("animated-number").textContent).toBe("42");
    expect(frameCallbacks).toHaveLength(0);
  });

  it("counts through intermediate values to the new value", () => {
    mockMotion(false);
    const { rerender } = render(<AnimatedNumber value={0} />);
    rerender(<AnimatedNumber value={100} />);
    const el = screen.getByTestId("animated-number");

    advance(100);
    const mid = Number(el.textContent);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);

    advance(200);
    expect(el.textContent).toBe("100");
  });

  it("jumps straight to the new value under reduced motion", () => {
    mockMotion(true);
    const { rerender } = render(<AnimatedNumber value={3} />);
    rerender(<AnimatedNumber value={4} />);

    expect(screen.getByTestId("animated-number").textContent).toBe("4");
    expect(frameCallbacks).toHaveLength(0);
  });

  it("applies the format function to every frame", () => {
    mockMotion(true);
    render(
      <AnimatedNumber
        value={1}
        format={(n) => (n === 1 ? "1 like" : `${n} likes`)}
      />,
    );

    expect(screen.getByTestId("animated-number").textContent).toBe("1 like");
  });

  it("uses tabular numerals so digits do not shift while counting", () => {
    mockMotion(false);
    render(<AnimatedNumber value={7} />);

    expect(screen.getByTestId("animated-number").className).toContain(
      "tabular-nums",
    );
  });
});

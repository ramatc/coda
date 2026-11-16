"use client";

import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

/** Matches `--motion-base`: a small state change. */
const DURATION_MS = 200;

/**
 * Decelerating, no overshoot. A JS stand-in for the `--ease-out` token
 * (`cubic-bezier(0.2, 0, 0, 1)`), which this curve tracks closely.
 */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 4;
}

/** No `matchMedia` (SSR, old test DOMs) is treated as "do not animate". */
function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface AnimatedNumberProps {
  /** The whole number to show. Changes count toward it; the first render does not animate. */
  value: number;
  /** Turns each frame's integer into text, e.g. `likeCountLabel`. Default `String`. */
  format?: (value: number) => string;
  className?: string;
}

/**
 * A count that ticks to its new value over `--motion-base` instead of
 * jumping. An interrupted count starts from what is on screen, so rapid
 * changes never snap backwards. Reduced motion shows the new value at once.
 */
export function AnimatedNumber({
  value,
  format = String,
  className,
}: AnimatedNumberProps) {
  // `tween` exists only while counting; otherwise `value` renders directly,
  // so the text never lags a render behind the prop.
  const [tween, setTween] = useState<{ from: number; current: number } | null>(
    null,
  );
  const [previous, setPrevious] = useState(value);
  if (previous !== value) {
    // Adjust-state-during-render: start the next count from what is on screen.
    const onScreen = tween?.current ?? previous;
    setPrevious(value);
    setTween(
      prefersReducedMotion() ? null : { from: onScreen, current: onScreen },
    );
  }
  const from = tween?.from;

  useEffect(() => {
    if (from === undefined) {
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(time: number) {
      const progress = Math.min(1, (time - start) / DURATION_MS);
      if (progress < 1) {
        const current = Math.round(from + (value - from) * easeOut(progress));
        setTween({ from, current });
        frame = requestAnimationFrame(tick);
      } else {
        setTween(null);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [from, value]);

  const shown = tween?.current ?? value;

  return (
    <span
      className={cn("tabular-nums", className)}
      data-testid="animated-number"
    >
      {format(shown)}
    </span>
  );
}

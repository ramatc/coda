"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../lib/cn";
import {
  SEGMENT_COUNT,
  SIZE_CONFIG,
  VARIANT_FILL_CLASS,
  segmentFillPercent,
  warnMissingOnChange,
  type RatingScaleSize,
  type RatingScaleVariant,
} from "./rating-scale-core";

interface InteractiveSegmentsProps {
  /** Whole-number score 1–10, or `null` when unrated. */
  value: number | null;
  size: RatingScaleSize;
  variant: RatingScaleVariant;
  disabled: boolean;
  onChange?: (score: number) => void;
}

/**
 * The rating input: a `radiogroup` of ten options. Each option is a 24×24px
 * hit area wrapping the small visual segment (the segment is never the whole
 * target). One tab stop (roving tabindex):
 *
 * - ArrowRight/ArrowUp, ArrowLeft/ArrowDown, Home, End move focus and preview.
 * - Enter/Space or click commits the focused score.
 *
 * Arrows deliberately do not commit, so moving through the scale never fires
 * one save per keypress. The selected option is also taller than the rest, so
 * the selected state does not depend on color alone.
 *
 * Its own `"use client"` module so the read-only display stays hook-free.
 */
export function InteractiveSegments({
  value,
  size,
  variant,
  disabled,
  onChange,
}: InteractiveSegmentsProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const config = SIZE_CONFIG[size];
  const fillClass = VARIANT_FILL_CLASS[variant];
  const fillValue = !disabled && hoverIndex !== null ? hoverIndex + 1 : value;
  const handleChange = onChange ?? warnMissingOnChange;
  const tabIndexTarget = value === null ? 0 : value - 1;

  function moveFocus(index: number) {
    const next = Math.min(SEGMENT_COUNT - 1, Math.max(0, index));
    buttons.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowUp: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index - 1,
      Home: 0,
      End: SEGMENT_COUNT - 1,
    };
    const target = moves[event.key];
    if (target !== undefined) {
      event.preventDefault();
      moveFocus(target);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Your rating"
      aria-disabled={disabled || undefined}
      className="inline-flex items-center"
    >
      {Array.from({ length: SEGMENT_COUNT }, (_, index) => {
        const fill = segmentFillPercent(fillValue, index);
        const checked = value === index + 1;
        return (
          <button
            key={index}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={`Rate ${index + 1} out of 10`}
            data-testid="rating-scale-option"
            disabled={disabled}
            tabIndex={index === tabIndexTarget ? 0 : -1}
            className={cn(
              "focus-ring inline-flex h-6 w-6 items-center justify-center rounded-[2px] border-0 bg-transparent p-0",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
            onClick={disabled ? undefined : () => handleChange(index + 1)}
            onKeyDown={disabled ? undefined : (e) => onKeyDown(e, index)}
            onMouseEnter={disabled ? undefined : () => setHoverIndex(index)}
            onMouseLeave={disabled ? undefined : () => setHoverIndex(null)}
            onFocus={disabled ? undefined : () => setHoverIndex(index)}
            onBlur={disabled ? undefined : () => setHoverIndex(null)}
          >
            <span
              data-testid="rating-scale-segment"
              data-selected={checked || undefined}
              className="relative overflow-hidden rounded-[1px] bg-surface-2"
              style={{
                width: config.segmentWidth,
                height: checked
                  ? `calc(${config.segmentHeight} + 6px)`
                  : config.segmentHeight,
              }}
            >
              <span
                className={cn("absolute inset-y-0 left-0", fillClass)}
                style={{ width: `${fill}%` }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

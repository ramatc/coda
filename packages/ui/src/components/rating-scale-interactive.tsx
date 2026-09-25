"use client";

import { useState } from "react";
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
  value: number | null;
  size: RatingScaleSize;
  variant: RatingScaleVariant;
  disabled: boolean;
  onChange?: (score: number) => void;
}

/**
 * The interactive segment row for `RatingScale`. Split into its own
 * `"use client"` module — and thus its own component — so that the hover
 * state hook here never taints the default read-only `RatingScale`, which
 * must stay renderable from a plain Server Component (e.g. the feed and
 * friends-preview rows) with zero client JS.
 */
export function InteractiveSegments({
  value,
  size,
  variant,
  disabled,
  onChange,
}: InteractiveSegmentsProps) {
  // Tracks the hovered/focused segment for the live fill preview — the one
  // deliberate interactive touch, kept narrowly scoped to just the fill (the
  // numeric readout, owned by the parent, never previews).
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const config = SIZE_CONFIG[size];
  const fillClass = VARIANT_FILL_CLASS[variant];
  const previewActive = !disabled && hoverIndex !== null;
  const fillValue = previewActive ? hoverIndex! + 1 : value;
  const handleChange = onChange ?? warnMissingOnChange;

  return (
    <div className="inline-flex items-end" style={{ gap: config.segmentGap }}>
      {Array.from({ length: SEGMENT_COUNT }, (_, index) => {
        const fill = segmentFillPercent(fillValue, index);
        return (
          <button
            key={index}
            type="button"
            data-testid="rating-scale-segment"
            aria-label={`Rate ${index + 1} out of 10`}
            aria-disabled={disabled}
            disabled={disabled}
            className={cn(
              "relative overflow-hidden rounded-[1px] border-0 bg-surface-2 p-0",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
            style={{ width: config.segmentWidth, height: config.segmentHeight }}
            onClick={disabled ? undefined : () => handleChange(index + 1)}
            onMouseEnter={disabled ? undefined : () => setHoverIndex(index)}
            onMouseLeave={disabled ? undefined : () => setHoverIndex(null)}
            onFocus={disabled ? undefined : () => setHoverIndex(index)}
            onBlur={disabled ? undefined : () => setHoverIndex(null)}
          >
            <span
              className={cn("absolute inset-y-0 left-0", fillClass)}
              style={{ width: `${fill}%` }}
            />
          </button>
        );
      })}
    </div>
  );
}

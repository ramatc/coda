import { cn } from "../lib/cn";
import { InteractiveSegments } from "./rating-scale-interactive";
import {
  SEGMENT_COUNT,
  SIZE_CONFIG,
  VARIANT_FILL_CLASS,
  normalize,
  segmentFillPercent,
  type RatingScaleProps,
  type RatingScaleSize,
  type RatingScaleVariant,
} from "./rating-scale-core";

export type {
  RatingScaleProps,
  RatingScaleVariant,
  RatingScaleSize,
} from "./rating-scale-core";

/** The read-only segment row: plain decorative `<span>`s, no hooks — safe in a Server Component. */
function ReadOnlySegments({
  value,
  size,
  variant,
}: {
  value: number | null;
  size: RatingScaleSize;
  variant: RatingScaleVariant;
}) {
  const config = SIZE_CONFIG[size];
  const fillClass = VARIANT_FILL_CLASS[variant];

  return (
    <span
      className="inline-flex items-end"
      style={{ gap: config.segmentGap }}
      aria-hidden="true"
    >
      {Array.from({ length: SEGMENT_COUNT }, (_, index) => {
        const fill = segmentFillPercent(value, index);
        return (
          <span
            key={index}
            data-testid="rating-scale-segment"
            className="relative overflow-hidden rounded-[1px] bg-surface-2"
            style={{ width: config.segmentWidth, height: config.segmentHeight }}
          >
            <span
              className={cn("absolute inset-y-0 left-0", fillClass)}
              style={{ width: `${fill}%` }}
            />
          </span>
        );
      })}
    </span>
  );
}

/**
 * Coda's rating display: a value from 1.0 to 10.0 rendered as ten compact
 * rectangular segments (never stars), the current segment partially filled by
 * the decimal fraction.
 *
 * Display-only by default, and safe to render from a plain Server Component
 * (no hooks in this module) — reusable across feed rows, album detail,
 * reviews, profile, and lists:
 * ```
 * <RatingScale value={item.score} variant="other" size="sm" />
 * ```
 *
 * Pass `interactive` (with `onChange`) to turn it into the real rating input:
 * each segment becomes a real, independently clickable/focusable button that
 * always reports a whole-number score, with a live hover/focus fill preview.
 * The hover-state hook this needs lives in a separate `"use client"` segment
 * component ({@link InteractiveSegments}) so it never taints this module.
 * ```
 * <RatingScale value={viewer.score} interactive onChange={setScore} />
 * ```
 */
export function RatingScale(props: RatingScaleProps) {
  const {
    value,
    variant = "other",
    size = "md",
    showValue = true,
    valuePosition = "left",
    className,
  } = props;
  const config = SIZE_CONFIG[size];

  const normalized = value === null ? null : normalize(value);

  const valueText = normalized === null ? "–" : normalized.toFixed(1);
  // Only carries its own aria-label in interactive mode, where the wrapper
  // deliberately has none (see below) — in read-only mode the wrapper's own
  // aria-label already announces "Not rated", so labeling the inner span too
  // would just double it up.
  const valueAriaLabel =
    props.interactive && normalized === null ? "Not rated" : undefined;

  const valueEl = showValue ? (
    <span
      className={cn("font-semibold tabular-nums", config.valueText)}
      data-testid="rating-scale-value"
      aria-label={valueAriaLabel}
    >
      {valueText}
    </span>
  ) : null;

  // In read-only mode the wrapper carries the accessible name (unchanged
  // from before this component gained an interactive mode). In interactive
  // mode the buttons carry their own `aria-label`s, so the wrapper drops its
  // own to avoid a redundant/conflicting accessible name on a now-focusable
  // group of controls.
  const wrapperAriaLabel = props.interactive
    ? undefined
    : normalized === null
      ? "Not rated"
      : `Rating ${normalized.toFixed(1)} out of 10`;

  return (
    <span
      className={cn("inline-flex items-center", config.wrapperGap, className)}
      data-testid="rating-scale"
      aria-label={wrapperAriaLabel}
    >
      {valuePosition === "left" ? valueEl : null}
      {props.interactive ? (
        <InteractiveSegments
          value={normalized}
          size={size}
          variant={variant}
          disabled={props.disabled ?? false}
          onChange={props.onChange}
        />
      ) : (
        <ReadOnlySegments value={normalized} size={size} variant={variant} />
      )}
      {valuePosition === "right" ? valueEl : null}
    </span>
  );
}

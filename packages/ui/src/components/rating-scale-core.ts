export type RatingScaleVariant = "personal" | "other" | "aggregate";
export type RatingScaleSize = "sm" | "md" | "lg";

interface RatingScaleBaseProps {
  /**
   * The rating, 1.0–10.0. Clamped into range and rounded to the nearest 0.1.
   * `null` means "not yet rated": every segment renders empty and, when
   * `showValue` is true, the numeric readout shows a neutral placeholder
   * instead of a fake value.
   */
  value: number | null;
  /**
   * Whose rating this is: `personal` (the viewer's own — coda violet, the
   * only place violet means "your relationship with this music"), `other`
   * (someone else's rating — neutral), or `aggregate` (a community average —
   * muted).
   */
  variant?: RatingScaleVariant;
  size?: RatingScaleSize;
  /** Whether to render the numeric value alongside the segments. Default `true`. */
  showValue?: boolean;
  /** Which side of the segments the value renders on. Default `"left"`. */
  valuePosition?: "left" | "right";
  className?: string;
}

export interface RatingScaleReadOnlyProps extends RatingScaleBaseProps {
  interactive?: false;
}

export interface RatingScaleInteractiveProps extends RatingScaleBaseProps {
  /**
   * Renders each segment as a real, independently focusable `<button>` (10
   * plain tab stops — deliberately not a roving-tabindex radiogroup) and
   * enables click-to-rate and hover/focus fill preview. Requires `onChange`.
   */
  interactive: true;
  /**
   * Called with the whole-number score (1-10) for the clicked segment.
   * Interactive mode always outputs a whole number regardless of the
   * underlying `value`'s decimal precision — the app's rating input is
   * integer-only; fractional display is only ever for aggregates/averages.
   */
  onChange: (score: number) => void;
  /**
   * Mirrors this codebase's `busy`/`reviewBusy` pattern for disabling
   * controls during an in-flight mutation: segments stay visible and keep
   * showing `value`, but stop responding to click/hover/focus.
   */
  disabled?: boolean;
}

export type RatingScaleProps =
  | RatingScaleReadOnlyProps
  | RatingScaleInteractiveProps;

export const SEGMENT_COUNT = 10;
const MIN_VALUE = 1;
const MAX_VALUE = 10;

export const SIZE_CONFIG: Record<
  RatingScaleSize,
  {
    segmentWidth: string;
    segmentHeight: string;
    segmentGap: string;
    wrapperGap: string;
    valueText: string;
  }
> = {
  sm: {
    segmentWidth: "3px",
    segmentHeight: "8px",
    segmentGap: "2px",
    wrapperGap: "gap-1.5",
    valueText: "text-xs",
  },
  md: {
    segmentWidth: "4px",
    segmentHeight: "12px",
    segmentGap: "2px",
    wrapperGap: "gap-2",
    valueText: "text-sm",
  },
  lg: {
    segmentWidth: "5px",
    segmentHeight: "16px",
    segmentGap: "3px",
    wrapperGap: "gap-2.5",
    valueText: "text-base",
  },
};

export const VARIANT_FILL_CLASS: Record<RatingScaleVariant, string> = {
  personal: "bg-coda",
  other: "bg-text-secondary",
  aggregate: "bg-coda-muted",
};

/** Clamps into `[MIN_VALUE, MAX_VALUE]` and rounds to the nearest 0.1. */
export function normalize(value: number): number {
  const clamped = Math.min(MAX_VALUE, Math.max(MIN_VALUE, value));
  return Math.round(clamped * 10) / 10;
}

/**
 * How full segment `index` (0-based) is, as a 0–100 percentage. Segment
 * `index` spans the range `(index, index + 1]`: fully filled once `value`
 * clears its upper bound, empty until `value` passes its lower bound, and
 * partially filled by the fraction in between — e.g. for `value = 9.1`,
 * segments 0–8 are 100% and segment 9 is 10%. `null` (not yet rated) is
 * always fully empty.
 */
export function segmentFillPercent(value: number | null, index: number): number {
  if (value === null) {
    return 0;
  }
  if (value >= index + 1) {
    return 100;
  }
  if (value <= index) {
    return 0;
  }
  // Rounded to whole percent: `value - index` is a multiple of 0.1 by
  // construction (`normalize` rounds to one decimal), but floating-point
  // subtraction can land a hair off (e.g. 9.1 - 9 = 9.999999999999964e-1),
  // which would render a visibly-not-quite-full segment.
  return Math.round((value - index) * 100);
}

/** Dev-only warning for the runtime fallback when `interactive` is used without a real `onChange` (TS enforces this at compile time; this only guards a JS/untyped caller). */
export function warnMissingOnChange() {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "RatingScale: `interactive` is true but no `onChange` was provided.",
    );
  }
}

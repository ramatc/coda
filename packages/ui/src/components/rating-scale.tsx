import { cn } from "../lib/cn";
import { InteractiveSegments } from "./rating-scale-interactive";
import {
  SEGMENT_COUNT,
  SIZE_CONFIG,
  VARIANT_FILL_CLASS,
  VARIANT_VALUE_CLASS,
  displayValue,
  formatRating,
  normalize,
  segmentFillPercent,
  type RatingScaleInteractiveProps,
  type RatingScaleProps,
  type RatingScaleReadOnlyProps,
  type RatingScaleSize,
  type RatingScaleVariant,
} from "./rating-scale-core";

export type {
  RatingScaleProps,
  RatingScaleReadOnlyProps,
  RatingScaleInteractiveProps,
  RatingScaleVariant,
  RatingScaleSize,
} from "./rating-scale-core";

/** Decorative segment row: plain `<span>`s, no hooks — safe in a Server Component. */
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

function ValueText({
  text,
  size,
  variant,
}: {
  text: string;
  size: RatingScaleSize;
  variant: RatingScaleVariant;
}) {
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        SIZE_CONFIG[size].valueText,
        VARIANT_VALUE_CLASS[variant],
      )}
      data-testid="rating-scale-value"
      aria-hidden="true"
    >
      {text}
    </span>
  );
}

/**
 * Coda's rating display: ten compact segments, never stars.
 *
 * - `personal` (the viewer's own): violet, whole number — `9`, not `9.0`.
 * - `other` (someone else's): off-white, whole number.
 * - `aggregate` (community average): grey, one decimal (`8.4`) with a
 *   fractional segment fill.
 *
 * Hook-free, safe in a Server Component:
 * ```
 * <RatingScaleDisplay value={item.score} variant="other" size="sm" />
 * ```
 */
export function RatingScaleDisplay({
  value,
  variant = "other",
  size = "md",
  showValue = true,
  valuePosition = "left",
  className,
}: Omit<RatingScaleReadOnlyProps, "interactive">) {
  const shown = value === null ? null : displayValue(normalize(value), variant);
  const text = shown === null ? "–" : formatRating(shown, variant);
  const label = shown === null ? "Not rated" : `Rating ${text} out of 10`;
  const valueEl = showValue ? (
    <ValueText text={text} size={size} variant={variant} />
  ) : null;

  return (
    <span
      role="img"
      className={cn(
        "inline-flex items-center",
        SIZE_CONFIG[size].wrapperGap,
        className,
      )}
      data-testid="rating-scale"
      aria-label={label}
    >
      {valuePosition === "left" ? valueEl : null}
      <ReadOnlySegments value={shown} size={size} variant={variant} />
      {valuePosition === "right" ? valueEl : null}
    </span>
  );
}

/**
 * The rating input. Always whole numbers 1–10 (an incoming decimal is
 * rounded), keyboard operable, 24×24px per option. See {@link InteractiveSegments}.
 * ```
 * <RatingScaleInteractive value={viewer.score} onChange={setScore} />
 * ```
 */
export function RatingScaleInteractive({
  value,
  variant = "personal",
  size = "md",
  showValue = true,
  valuePosition = "left",
  className,
  onChange,
  disabled = false,
}: Omit<RatingScaleInteractiveProps, "interactive">) {
  const shown = value === null ? null : Math.round(normalize(value));
  const valueEl = showValue ? (
    <ValueText
      text={shown === null ? "–" : String(shown)}
      size={size}
      variant={variant}
    />
  ) : null;

  return (
    <span
      className={cn(
        "inline-flex items-center",
        SIZE_CONFIG[size].wrapperGap,
        className,
      )}
      data-testid="rating-scale"
    >
      {valuePosition === "left" ? valueEl : null}
      <InteractiveSegments
        value={shown}
        size={size}
        variant={variant}
        disabled={disabled}
        onChange={onChange}
      />
      {valuePosition === "right" ? valueEl : null}
    </span>
  );
}

/**
 * Convenience entry point kept for existing call sites: renders
 * {@link RatingScaleInteractive} when `interactive` is set, otherwise
 * {@link RatingScaleDisplay}.
 */
export function RatingScale(props: RatingScaleProps) {
  if (props.interactive) {
    const { interactive: _interactive, ...rest } = props;
    return <RatingScaleInteractive {...rest} />;
  }
  const { interactive: _interactive, ...rest } = props;
  return <RatingScaleDisplay {...rest} />;
}

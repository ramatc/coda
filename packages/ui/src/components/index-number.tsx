import { cn } from "../lib/cn";

export interface IndexNumberProps {
  /** 1-based editorial position. Rendered zero-padded: `1` → `01`. */
  value: number;
  /** Minimum digit count. Default 2. */
  digits?: number;
  /** Size and color come from the caller (e.g. `text-h2 text-text-tertiary`). */
  className?: string;
}

/**
 * Coda Index: the editorial position number of a ranked list (`01`, `02`).
 * Tabular numerals keep a column of positions aligned.
 */
export function IndexNumber({
  value,
  digits = 2,
  className,
}: IndexNumberProps) {
  const text = String(Math.max(0, Math.trunc(value))).padStart(digits, "0");
  return (
    <span
      className={cn("font-semibold tabular-nums", className)}
      data-testid="index-number"
    >
      {text}
    </span>
  );
}

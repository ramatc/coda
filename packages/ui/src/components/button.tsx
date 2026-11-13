import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

/**
 * Button styles, also usable on links: `className={buttonVariants({ variant: "secondary" })}`.
 *
 * - `primary`: the one main action — violet fill (`coda-solid`, 5:1 with text).
 * - `secondary`: bordered, neutral.
 * - `tertiary`: text-only, neutral.
 * - `destructive`: irreversible actions (delete, remove).
 *
 * No glow, gradients or shadows. Disabled keeps the shape and lowers opacity.
 */
const buttonVariants = cva(
  "focus-ring inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-coda-solid text-text-primary hover:bg-coda-solid-hover",
        secondary:
          "border border-border-strong text-text-primary hover:bg-surface-2",
        tertiary:
          "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
        destructive:
          "bg-danger-solid text-text-primary hover:bg-danger-solid-hover",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-body",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant, size, type = "button", ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);

export { buttonVariants };

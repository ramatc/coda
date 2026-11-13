import * as React from "react";
import { cn } from "../lib/cn";

/**
 * Shared look for text-entry controls. `aria-invalid` drives the error state
 * so the visual and the accessibility tree never disagree.
 */
const controlClass =
  "focus-ring w-full rounded-control border border-border-strong bg-surface-1 px-3 text-small text-text-primary placeholder:text-text-tertiary transition-colors hover:border-text-tertiary disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger";

type InvalidProp = {
  /** Shows the error state and sets `aria-invalid`. */
  invalid?: boolean;
};

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> &
  InvalidProp;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, invalid, ...props }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(controlClass, "h-10", className)}
        {...props}
      />
    );
  },
);

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> &
  InvalidProp;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(controlClass, "min-h-24 py-2", className)}
        {...props}
      />
    );
  },
);

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> &
  InvalidProp;

/** Native `<select>`; `color-scheme: dark` keeps its popup dark. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ className, invalid, ...props }, ref) {
    return (
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(controlClass, "h-10 pr-8", className)}
        {...props}
      />
    );
  },
);

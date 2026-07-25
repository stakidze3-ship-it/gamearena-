import * as React from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "icon" | "icon-sm";

const base =
  "relative inline-flex items-center justify-center gap-2 rounded-lg font-medium select-none whitespace-nowrap " +
  "transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-out " +
  "active:scale-[0.97] active:ease-spring disabled:opacity-45 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-gold text-bg hover:bg-gold-bright",
  secondary:
    "bg-surface text-fg border border-border hover:border-border-strong hover:bg-raised",
  ghost: "text-muted hover:text-fg hover:bg-surface",
  danger: "border border-loss/40 text-loss hover:bg-loss/10",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-base",
  lg: "h-12 px-6 text-md",
  icon: "h-10 w-10 p-0",
  "icon-sm": "h-8 w-8 p-0",
};

function Spinner() {
  return (
    <span
      className="absolute inset-0 inline-flex items-center justify-center"
      aria-hidden
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
    </span>
  );
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Replaces the label with a spinner; width is preserved. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = "secondary", size = "md", type = "button", loading = false, disabled, children, ...props },
    ref
  ) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    >
      {loading && <Spinner />}
      <span className={cn("contents", loading && "invisible")}>{children}</span>
    </button>
  )
);
Button.displayName = "Button";

/** A link that looks exactly like a Button — avoids Link>Button nesting. */
export function buttonClasses({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}) {
  return cn(base, variants[variant], sizes[size], className);
}

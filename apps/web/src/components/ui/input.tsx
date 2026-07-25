import * as React from "react";
import { cn } from "@/lib/cn";
import { IconChevronDown } from "@/components/icons";

/* Shared control shell — inputs, selects, textareas all match Button metrics:
   h-10, px-4, rounded-lg. Focus = gold border + soft gold ring. */
const control =
  "w-full rounded-lg border border-border bg-bg text-base text-fg " +
  "placeholder:text-faint transition-[border-color,box-shadow] duration-150 " +
  "hover:border-border-strong focus:border-gold/60 focus:ring-[3px] focus:ring-gold/20 focus:outline-none";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(control, "h-10 px-4", className)} {...props} />
  )
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(control, "min-h-20 px-4 py-2", className)} {...props} />
));
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <span className="relative block w-full">
    <select
      ref={ref}
      className={cn(control, "h-10 appearance-none px-4 pr-9", className)}
      {...props}
    >
      {children}
    </select>
    <IconChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
  </span>
));
Select.displayName = "Select";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-45",
        checked ? "border-gold/60 bg-gold" : "border-border-strong bg-raised",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-[left,background-color] duration-150 ease-out",
          checked ? "left-6 bg-bg" : "left-1 bg-muted"
        )}
      />
    </button>
  );
}

export const Slider = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="range"
      className={cn("h-1.5 w-full cursor-pointer appearance-auto accent-gold", className)}
      {...props}
    />
  )
);
Slider.displayName = "Slider";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1.5 block text-sm font-medium text-fg-secondary", className)}
      {...props}
    />
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-sm text-loss">{children}</p>;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-sm text-muted">{children}</p>;
}

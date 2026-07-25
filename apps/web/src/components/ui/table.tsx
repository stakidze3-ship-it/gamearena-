import * as React from "react";
import { cn } from "@/lib/cn";

/*
 * The one table. Shell = rounded-lg bordered surface; head = 2xs uppercase
 * muted; rows divide with border. Numeric cells add .tnum themselves.
 */

export function Table({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className={cn("w-full text-sm", className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("bg-raised/60", className)} {...props} />;
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border", className)} {...props} />;
}

export function Tr({
  className,
  highlight = false,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { highlight?: boolean }) {
  return <tr className={cn(highlight && "bg-gold/6", className)} {...props} />;
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "px-4 py-2 text-left text-2xs font-medium uppercase tracking-wide text-muted",
        className
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-2 text-fg-secondary", className)} {...props} />;
}

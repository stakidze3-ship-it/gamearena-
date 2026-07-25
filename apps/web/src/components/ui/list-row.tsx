import * as React from "react";
import { cn } from "@/lib/cn";

/*
 * The one list. Use inside a Card: <List> divides rows, <ListRow> spaces them.
 * Dense (default) py-3 for data lists; comfortable py-4 for tappable rows.
 */

export function List({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("divide-y divide-border", className)} {...props} />;
}

export function ListRow({
  className,
  size = "dense",
  interactive = false,
  highlight = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  size?: "dense" | "comfortable";
  interactive?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-5",
        size === "dense" ? "py-3" : "py-4",
        interactive && "transition-colors duration-150 hover:bg-raised/60",
        highlight && "bg-gold/6",
        className
      )}
      {...props}
    />
  );
}

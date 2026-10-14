/**
 * Loading placeholder shapes.
 *
 * Wraps the generated `ui/skeleton` so that "what this screen looks like
 * while it loads" is decided once instead of per feature. `ui/skeleton` is
 * `bg-muted` with a pulse and no colour of its own, so light and dark mode
 * need no work here — which is the point of having it inherit the token.
 *
 * The aria-hidden default matters: a skeleton is not content, and announcing
 * twelve empty boxes to a screen reader is worse than announcing nothing.
 * Pass `aria-busy` on the region being loaded instead.
 */
import type * as React from "react";

import { Skeleton as SkeletonPrimitive } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/cn";

export interface SkeletonProps extends React.ComponentProps<typeof SkeletonPrimitive> {
  /** Named shapes, so a screen's loading state reads like its loaded state. */
  size?: "line" | "title" | "block" | "avatar";
}

const SIZE_CLASSES: Record<NonNullable<SkeletonProps["size"]>, string> = {
  line: "h-4 w-full",
  title: "h-6 w-2/5",
  block: "h-24 w-full",
  avatar: "size-10 rounded-full",
};

export function Skeleton({ size = "line", className, ...props }: SkeletonProps) {
  return (
    <SkeletonPrimitive
      aria-hidden="true"
      data-size={size}
      className={cn(SIZE_CLASSES[size], className)}
      {...props}
    />
  );
}

export interface SkeletonRowsProps extends React.ComponentProps<"div"> {
  /** How many placeholder rows to draw. Matches the loaded row height. */
  count?: number;
}

/**
 * Placeholder rows for a table that is still loading. Pairs with
 * `DataTable`'s `loading` prop; exported separately so a skeleton screen can
 * reproduce a table's shape without mounting the table.
 */
export function SkeletonRows({ count = 5, className, ...props }: SkeletonRowsProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)} {...props}>
      {Array.from({ length: Math.max(0, count) }, (_, index) => (
        <Skeleton key={index} size="line" />
      ))}
    </div>
  );
}

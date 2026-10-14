/**
 * Status pill for a row of data.
 *
 * SCOPE. This is the reusable tone primitive, not the domain vocabulary. Which
 * domain statuses exist — `overdue`, `checked_in`, `draft` — and which tone
 * each one takes is application policy and belongs to the feature that owns
 * those statuses; keeping it out of the design system is what stops every
 * feature inventing its own green. Callers map their status to a `tone` here.
 *
 * COLOUR. Each tone is a *filled* token pair, never a tinted background with a
 * raw brand colour on top: `--brand-success` measures 3.06:1 on white, so it
 * is only readable as the fill under `--success-foreground` (5.71:1). The
 * reasoning does NOT generalise to the other tones, which is worth spelling
 * out because the naive version of it is wrong: `--brand-secondary` clears AA
 * as text on its own at 4.93:1 on `--background`, so `info` could have been
 * written as a tinted background with `--brand-secondary` text and been fine.
 * `--brand-primary` at 2.93:1 and `--brand-neutral` at 1.84:1 could not. Every
 * pair this component can produce is asserted at AA or better in both modes by
 * tests/unit/design-tokens.test.ts, so a future palette change cannot quietly
 * make a pill unreadable.
 */
import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/cn";

export type StatusTone = "success" | "danger" | "info" | "pending" | "neutral";

/**
 * Filled token pairs. Every entry is a `*-background` / `*-foreground` pair
 * from app/globals.css, which is what makes each of them contrast-checked by
 * construction.
 */
const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success text-success-foreground",
  danger: "bg-destructive text-destructive-foreground",
  info: "bg-secondary text-secondary-foreground",
  pending: "bg-accent text-accent-foreground",
  neutral: "bg-muted text-muted-foreground",
};

export interface StatusBadgeProps extends Omit<React.ComponentProps<typeof Badge>, "children"> {
  /** The status as the user reads it. */
  label: React.ReactNode;
  /** Semantic tone. Defaults to `neutral`, the least committal option. */
  tone?: StatusTone;
}

export function StatusBadge({ label, tone = "neutral", className, ...props }: StatusBadgeProps) {
  return (
    <Badge data-tone={tone} className={cn(TONE_CLASSES[tone], className)} {...props}>
      {label}
    </Badge>
  );
}

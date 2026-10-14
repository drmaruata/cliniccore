/**
 * One headline number on a dashboard, with its label and an optional
 * period-over-period delta.
 *
 * MONEY. `value` is a `ReactNode` on purpose. ClinicCore money is bigint minor
 * units and must never round-trip through a float, so this component does no
 * arithmetic and offers no `number` shorthand: the caller formats minor units
 * into a string and passes that in. A component that accepted a number would
 * eventually receive one already divided by 100.
 *
 * COLOUR. The figure itself is `text-foreground`, not a brand colour — a KPI
 * is a measurement, and colouring every number on a dashboard by mood is how a
 * dashboard becomes unreadable. Colour is spent only on the delta, and only
 * where it carries meaning: `success-ink` and `destructive-ink` are the
 * on-surface variants of the brand success and destructive, darkened in light
 * mode until they clear AA as text (the raw brand success is 3.06:1 on white).
 * `neutral` is the default so an unlabelled or zero delta never implies a
 * direction it does not have.
 */
import type * as React from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils/cn";

/** Direction is stated explicitly. `flat` is a real answer, not a missing one. */
export type KpiDirection = "up" | "down" | "flat";

const DIRECTION_CLASSES: Record<KpiDirection, string> = {
  up: "text-success-ink",
  down: "text-destructive-ink",
  flat: "text-muted-foreground",
};

export interface KpiDelta {
  direction: KpiDirection;
  /** Already-formatted change, e.g. "+12.4% vs last month". */
  label: React.ReactNode;
}

export interface KpiCardProps extends React.ComponentProps<typeof Card> {
  /** What the number measures. */
  label: React.ReactNode;
  /**
   * The figure, pre-formatted. Money arrives as a string built from bigint
   * minor units; this component never parses or divides it.
   */
  value: React.ReactNode;
  /** Secondary context under the label. */
  hint?: React.ReactNode;
  /** Period-over-period change. Omit when there is no comparison to make. */
  delta?: KpiDelta;
}

export function KpiCard({ label, value, hint, delta, className, ...props }: KpiCardProps) {
  return (
    <Card className={cn("min-w-0", className)} {...props}>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {hint !== undefined && <CardDescription>{hint}</CardDescription>}
      </CardHeader>
      <CardContent className="flex items-end justify-between gap-3">
        <span
          data-slot="kpi-value"
          className="font-heading text-3xl leading-none font-semibold tracking-tight text-foreground tabular-nums"
        >
          {value}
        </span>
        {delta !== undefined && (
          <span
            data-slot="kpi-delta"
            data-direction={delta.direction}
            className={cn("text-sm font-medium", DIRECTION_CLASSES[delta.direction])}
          >
            {delta.label}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

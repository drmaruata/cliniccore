/**
 * "There is nothing here" — the state every list in ClinicCore has to render
 * when a query succeeds and returns no rows.
 *
 * COLOUR. Deliberately the quietest surface on the page: a `bg-muted` icon
 * well with `text-muted-foreground` inside it, on the inherited card surface.
 * An empty state is not an error, so it must not borrow `destructive`, and it
 * must not borrow `primary` either — a saturated colour in an empty region
 * reads as a call to action that does not exist. The action, when one is
 * offered, is a real `Button`, which is the one thing here allowed to be loud.
 */
import type * as React from "react";

import { cn } from "@/lib/utils/cn";

export interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "title"> {
  /**
   * Icon or short glyph. `lucide-react` icons at `size-5` are the house
   * style; any node works.
   */
  icon?: React.ReactNode;
  /** What is missing, in the user's words: "No patients yet". */
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      {icon !== undefined && (
        <div
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description !== undefined && (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      )}
      {action !== undefined && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * Page-level heading block: title, optional description, optional action slot.
 *
 * COLOUR. The title is `text-brand-navy`, not `text-foreground`. Navy is the
 * brand's typography-and-emphasis colour and the brief restricts it to that
 * job; `foreground` is the neutral body colour and is used for the supporting
 * description's companion text. Nothing here names a colour value — the token
 * flips between light and dark mode on its own, so there is deliberately no
 * `dark:` override on the heading.
 */
import type * as React from "react";

import { cn } from "@/lib/utils/cn";

/** `title` is omitted from the DOM props: the heading owns that name here. */
export interface PageHeaderProps extends Omit<React.ComponentProps<"header">, "title"> {
  /** Page or section title. Rendered as the page's single `h1`. */
  title: React.ReactNode;
  /** One line of context under the title. Omit to render a bare heading. */
  description?: React.ReactNode;
  /** Buttons or a menu, right-aligned on wide viewports. */
  actions?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 border-b border-border pb-5",
        actions !== undefined && "sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl leading-tight font-semibold tracking-tight text-brand-navy">
          {title}
        </h1>
        {description !== undefined && (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        )}
        {children}
      </div>
      {actions !== undefined && (
        // `data-slot` marks the slot's presence, the same convention shadcn's
        // generated primitives use, so a caller or a test can tell "no actions
        // were supplied" apart from "actions were supplied and rendered empty".
        <div data-slot="page-header-actions" className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}

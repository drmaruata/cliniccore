"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils/cn";

/**
 * The sidebar navigation: the links the signed-in user can act on.
 *
 * WHY THE ITEMS ARE A PROP. The list is not a constant - the members route is only
 * offered to a holder of `staff.manage`, and that answer comes from the database
 * (`public.can`), so the server decides which items exist. A hard-coded list would show
 * a route the user cannot use, or hide one they can.
 *
 * WHY THE ACTIVE STATE IS HERE AND NOT IN THE SERVER. The current path is a browser
 * fact, and reading it is a browser API - so this is the one piece of the shell that
 * has to be a client component. The links themselves are ordinary anchors.
 */

export interface NavItem {
  href: string;
  label: string;
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

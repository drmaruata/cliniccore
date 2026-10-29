import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The public header: the brand, section anchors, and the two ways in.
 *
 * IT READS NOTHING. The marketing shell is a public page, so it must not ask who the
 * visitor is - a header that changed for a signed-in visitor would leak the fact that
 * somebody is signed in, and every link here is the same for everybody.
 *
 * THE NAV NAMES ANCHORS, NOT PAGES. The full marketing page set - features, pricing,
 * security, legal - is a later phase, so the nav points at sections of THIS page
 * instead of at routes that would answer 404.
 */
const NAV = [
  { href: "#features", label: "Product" },
  { href: "#security", label: "Security" },
  { href: "#roadmap", label: "Roadmap" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 bg-background/75 shadow-lg shadow-brand-navy/5 backdrop-blur-xl">
      <div className="mx-auto flex h-18 max-w-7xl items-center gap-8 px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span aria-hidden="true" className="relative size-7">
            <span className="absolute top-0 left-1/2 h-7 w-2.5 -translate-x-1/2 rounded-full bg-primary" />
            <span className="absolute top-1/2 left-0 h-2.5 w-7 -translate-y-1/2 rounded-full bg-success" />
          </span>
          <span className="font-heading text-lg font-semibold tracking-tight text-brand-navy">
            ClinicCore
          </span>
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Account" className="ml-auto flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/signup">Get started</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}

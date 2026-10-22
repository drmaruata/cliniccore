import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The public header: the brand, and the two ways in.
 *
 * IT READS NOTHING. The marketing shell is a public page, so it must not ask who the
 * visitor is - a header that changed for a signed-in visitor would leak the fact that
 * somebody is signed in, and every link here is the same for everybody.
 */
export function SiteHeader() {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="font-heading text-lg font-semibold text-brand-navy">
          ClinicCore
        </Link>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/signup">Create your clinic</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}

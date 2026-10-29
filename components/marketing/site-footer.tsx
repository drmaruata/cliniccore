import Link from "next/link";

/**
 * The public footer.
 *
 * IT LINKS ONLY TO PAGES THAT EXIST. The reference design's Company and Support
 * columns (About, Contact, Privacy Policy, Help Center...) are dropped: those pages
 * do not exist in this release, and a footer full of links that would answer 404 is a
 * set of broken promises. Two product columns of real links - the page's own sections
 * and the two account routes - plus the truth about the release is the whole footer.
 */
const PRODUCT_LINKS = [
  { href: "/", label: "Overview" },
  { href: "/#features", label: "Platform" },
  { href: "/#security", label: "Security" },
  { href: "/#roadmap", label: "Roadmap" },
] as const;

const ACCOUNT_LINKS = [
  { href: "/login", label: "Sign in" },
  { href: "/signup", label: "Create your clinic" },
] as const;

const COLUMNS = [
  { title: "Product", links: PRODUCT_LINKS },
  { title: "Account", links: ACCOUNT_LINKS },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 sm:grid-cols-[1.4fr_1fr_1fr]">
        <div className="space-y-3">
          <p className="flex items-center gap-2.5">
            <span aria-hidden="true" className="relative size-7">
              <span className="absolute top-0 left-1/2 h-7 w-2.5 -translate-x-1/2 rounded-full bg-primary" />
              <span className="absolute top-1/2 left-0 h-2.5 w-7 -translate-y-1/2 rounded-full bg-success" />
            </span>
            <span className="font-heading text-lg font-semibold tracking-tight text-brand-navy">
              ClinicCore
            </span>
          </p>
          <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
            A modern, secure and flexible clinic management platform for real-world healthcare
            practices.
          </p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <p className="font-heading text-sm font-semibold text-foreground">{column.title}</p>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">© 2026 ClinicCore. All rights reserved.</p>
          <p className="text-xs text-muted-foreground">
            Built for healthcare providers. Foundation release: clinical records and payments arrive
            in a later phase.
          </p>
        </div>
      </div>
    </footer>
  );
}

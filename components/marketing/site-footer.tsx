import Link from "next/link";

/**
 * The public footer.
 *
 * IT LINKS ONLY TO PAGES THAT EXIST. The full marketing page set - features, pricing,
 * security, legal, SEO - is a later phase, so a footer full of links to pages that would
 * answer 404 is a set of broken promises. Two links and the truth about the release is
 * the whole footer.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="font-heading text-sm font-semibold text-brand-navy">ClinicCore</p>
          <p className="max-w-prose text-xs text-muted-foreground">
            Foundation release: the tenant model, the roles and the access control. Clinical records
            and payments arrive in a later phase.
          </p>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/login" className="text-primary-ink underline-offset-4 hover:underline">
            Sign in
          </Link>
          <Link href="/signup" className="text-primary-ink underline-offset-4 hover:underline">
            Create your clinic
          </Link>
        </nav>
      </div>
    </footer>
  );
}

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * The hero: what the product is, in one sentence and one paragraph.
 *
 * WHY THE COPY IS SO NARROW. The brief forbids claims that have not been verified, and
 * this release has no patient records, no appointments and no working payments - so the
 * copy says what is true today: the tenant model, the roles and the access control. Full
 * marketing copy is a later phase, and this is the visual foundation for it.
 *
 * AND IT SAYS WHAT EXISTS, NOT WHAT COULD. The product creates exactly ONE clinic per
 * organization, so the copy does not promise a practice with several of them; and the
 * roster shows a member's identifier and nothing else - `profiles` is readable only by
 * its owner - so the copy does not promise a list of names. It says "the people you
 * have given access to", which is what a membership is.
 */
export function Hero() {
  return (
    <section className="border-b border-border bg-muted/30">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm font-medium text-primary-ink">Multi-tenant clinic management</p>
        <h1 className="mt-3 max-w-3xl font-heading text-4xl font-semibold tracking-tight text-brand-navy sm:text-5xl">
          Each clinic gets its own workspace, and the database keeps them apart.
        </h1>
        <p className="mt-5 max-w-prose text-base text-muted-foreground">
          An organization is your clinic. Inside it are the people you have given access to, and the
          roles they hold. Your clinic&apos;s own records are tied to the organization they belong
          to, and row-level security decides who may read them - so isolation is a property of the
          schema rather than a promise made by the interface.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link href="/signup">Create your clinic</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

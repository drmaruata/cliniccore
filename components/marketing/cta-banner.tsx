import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The closing banner. The reference design's "Contact us" second button is replaced by
 * "Sign in" - there is no contact page to link to, and the footer links only to pages
 * that exist.
 */
export function CtaBanner() {
  return (
    <section className="relative overflow-hidden bg-[linear-gradient(125deg,var(--brand-secondary),var(--brand-navy))]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -left-16 size-72 rounded-full bg-success/30 blur-3xl motion-reduce:animate-none animate-float-slow"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-16 -bottom-24 size-80 rounded-full bg-primary/30 blur-3xl motion-reduce:animate-none animate-float"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-10 [background-image:radial-gradient(circle_at_1px_1px,var(--background)_1px,transparent_0)] [background-size:22px_22px]"
      />
      <div className="relative mx-auto max-w-7xl px-6 py-20 text-center lg:py-24">
        <h2 className="font-heading text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">
          Ready to simplify your clinic operations?
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-white/80">
          Create your clinic on the foundation today, and add clinical modules as your needs grow.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/signup">
              Get started
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <Button asChild size="lg" className="bg-white text-primary-foreground hover:bg-white/90">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

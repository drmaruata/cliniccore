import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleDashed, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The roadmap section: what the foundation ships, and what later phases add.
 *
 * WHY THIS IS HONEST RATHER THAN ASPIRATIONAL. Everything under "currently available"
 * is a thing this release can be asked about; everything under "coming in later
 * releases" is the plan's own phases 4-10, the same list the footer records - the
 * design spec plans patient records, appointments, encounters, billing, inventory and
 * reporting as later phases, and naming them as future keeps the page truthful. The
 * reference design's "View roadmap" button is replaced by the sign-up CTA: there is
 * no roadmap page to link to.
 */
const AVAILABLE = [
  "Organisation management",
  "Multi-tenant isolation",
  "Team and role management",
  "Secure and reliable foundation",
] as const;

const COMING = [
  "Patient management",
  "Appointments and scheduling",
  "Clinical encounters",
  "Billing and payments",
  "Inventory management",
  "Reports and analytics",
] as const;

export function RoadmapSection() {
  return (
    <section id="roadmap" className="scroll-mt-20 bg-background">
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-20 lg:grid-cols-2 lg:py-24">
        <div>
          <p className="text-xs font-semibold tracking-widest text-secondary uppercase">
            A platform that grows with you
          </p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-balance text-brand-navy sm:text-4xl">
            Start with the foundation. Add more as you grow.
          </h2>
          <p className="mt-4 max-w-prose leading-relaxed text-muted-foreground">
            ClinicCore is designed to evolve with your clinic&apos;s needs. The current release
            focuses on organisation and team management, with clinical modules coming in future
            releases.
          </p>
          <Button asChild className="mt-8">
            <Link href="/signup">
              Create your clinic
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col rounded-xl border border-secondary/30 bg-secondary/5 p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-secondary">
              <ShieldCheck aria-hidden="true" className="size-4" />
              Currently available
            </p>
            <ul className="mt-5 flex-1 space-y-3.5">
              {AVAILABLE.map((item) => (
                <li key={item} className="flex items-center gap-2.5">
                  <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-primary-ink" />
                  <span className="text-sm text-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col rounded-xl border border-border bg-muted/40 p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <CircleDashed aria-hidden="true" className="size-4" />
              Coming in future releases
            </p>
            <ul className="mt-5 flex-1 space-y-3.5">
              {COMING.map((item) => (
                <li key={item} className="flex items-center gap-2.5">
                  <CircleDashed aria-hidden="true" className="size-4 shrink-0 text-border" />
                  <span className="text-sm text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

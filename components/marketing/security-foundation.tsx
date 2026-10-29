import Link from "next/link";
import { ArrowRight, CheckCircle2, Lock, ScrollText, ShieldCheck, Users } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The security section: what the platform runs on, and what it records.
 *
 * WHY THE COPY IS SO NARROW. The brief forbids claims that have not been verified, so
 * "Regular updates and best practices" from the reference design - a promise about
 * future work this repo cannot back - is replaced by "Composite tenant keys", which is
 * a property MEASURED in the schema: the foreign keys that tie a record to another
 * tenant's clinic or patient are composite, so a record pointing at another clinic is
 * not representable, not merely hidden.
 *
 * THE VISUAL IS AN ILLUSTRATION, NOT A PHOTO. There is no licensed photography in this
 * repo, so the right panel is a token-drawn composition of the same three guarantees
 * the checklist names. It is aria-hidden because the checklist beside it carries the
 * same facts in readable text.
 */
const GUARANTEES = [
  "Row-level security (RLS)",
  "Secure authentication",
  "Comprehensive audit logs",
  "Composite tenant keys",
] as const;

const CHIPS = [
  { icon: Lock, title: "Secure data", meta: "Row-level security" },
  { icon: ScrollText, title: "Audit logs", meta: "Important actions recorded" },
  { icon: Users, title: "Access control", meta: "Role-based permissions" },
] as const;

export function SecurityFoundation() {
  return (
    <section id="security" className="scroll-mt-20 border-y border-border bg-background">
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-20 lg:grid-cols-2 lg:py-28">
        <div>
          <h2 className="font-heading text-3xl font-semibold tracking-tight text-balance text-brand-navy sm:text-4xl">
            Built on a secure and modern foundation
          </h2>
          <p className="mt-4 max-w-prose leading-relaxed text-muted-foreground">
            Your data security and privacy are our priority. ClinicCore is built on Supabase with
            row-level security, secure authentication and comprehensive audit logging to protect
            your organisation&apos;s data.
          </p>
          <ul className="mt-8 space-y-4">
            {GUARANTEES.map((guarantee) => (
              <li key={guarantee} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary"
                >
                  <CheckCircle2 className="size-4 text-primary-foreground" />
                </span>
                <span className="text-sm font-medium text-foreground">{guarantee}</span>
              </li>
            ))}
          </ul>
          <Button asChild variant="outline" className="mt-10">
            <Link href="#roadmap">
              See what comes next
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>

        <div aria-hidden="true" className="relative mx-auto w-full max-w-md lg:max-w-none">
          <div className="relative min-h-[22rem] overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-accent via-card to-secondary/10 p-6 lg:min-h-[26rem] lg:p-10">
            <ShieldCheck
              className="absolute -right-10 -bottom-14 size-72 text-primary/10"
              strokeWidth={1}
            />
            <div className="flex h-full flex-col items-center justify-center gap-6">
              <span className="flex size-20 items-center justify-center rounded-2xl border border-border bg-card shadow-lg shadow-brand-navy/5">
                <ShieldCheck className="size-10 text-primary-ink" strokeWidth={1.75} />
              </span>
              <div className="grid w-full max-w-sm gap-3">
                {CHIPS.map((chip, index) => (
                  <div
                    key={chip.title}
                    className={`flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-lg shadow-brand-navy/5 ${
                      index === 1 ? "translate-x-8" : index === 2 ? "translate-x-4" : ""
                    }`}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-primary-ink">
                      <chip.icon className="size-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-foreground">
                        {chip.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {chip.meta}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

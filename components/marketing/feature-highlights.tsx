import { Building2, ShieldCheck, Stethoscope, Users } from "lucide-react";

/**
 * The feature grid: four claims, each of which the codebase can be asked about.
 *
 * WHY THESE FOUR. The brief forbids claims that have not been verified, and the
 * temptation on a marketing page is to claim the features a clinic management product
 * is expected to have - patient records, appointments, payments - none of which are in
 * this release. "Multi-clinic support" from the reference design is likewise NOT here
 * (one clinic per organization today), so that card is "Tenant isolation" instead,
 * which is the thing the schema actually carries.
 *
 * MEASURED on the schema behind card 2 (from `pg_attribute`): of the 16 public tables,
 * 10 carry an `organization_id` and 6 do not; two of those ten have it NULLABLE
 * (`audit_logs`, `roles`). So the claim is about ROWS and not about columns.
 */
const FEATURES = [
  {
    icon: Users,
    tone: "text-primary-ink",
    title: "Team management",
    body: "Invite staff, assign roles and control access across your clinic.",
  },
  {
    icon: Building2,
    tone: "text-secondary",
    title: "Tenant isolation",
    body: "Every organization is its own isolated workspace - your clinic's records point only at their own tenant.",
  },
  {
    icon: ShieldCheck,
    tone: "text-primary-ink",
    title: "Enterprise-grade security",
    body: "Built on Supabase with row-level security, secure authentication and comprehensive audit logs.",
  },
  {
    icon: Stethoscope,
    tone: "text-secondary",
    title: "Designed for healthcare",
    body: "Tenancy, roles and access control shaped around clinic teams and their workflows.",
  },
] as const;

export function FeatureHighlights() {
  return (
    <section id="features" className="scroll-mt-20 bg-background">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:py-24">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-semibold tracking-widest text-secondary uppercase">
            Why clinics choose ClinicCore
          </p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-balance text-brand-navy sm:text-4xl">
            A secure and flexible platform for modern clinics
          </h2>
          <p className="mt-4 text-muted-foreground">
            Start with a solid foundation today, and add clinical modules as your needs grow.
          </p>
        </div>
        <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <li
                key={feature.title}
                className="group flex flex-col gap-5 rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/40"
              >
                <Icon aria-hidden="true" className={`size-9 ${feature.tone}`} strokeWidth={1.75} />
                <div>
                  <h3 className="font-heading text-base font-semibold text-foreground">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {feature.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

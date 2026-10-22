import { Clock, KeyRound, Lock, Mail } from "lucide-react";

/**
 * The feature highlights: four claims, each of which the codebase can be asked about.
 *
 * WHY THESE FOUR. Every one of them is true of the code that exists today, and each is
 * checkable against a specific part of it: the composite tenant keys on the clinic and
 * patient references, the fifteen seeded roles and the single permission function, the
 * invitation's digest and its proven address, and the tenant's own time zone. The brief
 * forbids claims that have not been
 * verified, and the temptation on a marketing page is to claim the features a clinic
 * management product is expected to have - patient records, appointments, payments -
 * none of which are in this release.
 *
 * AND THE COMPOSITE-KEY CLAIM IS NARROW ON PURPOSE. MEASURED: of the 21 public foreign
 * keys, 5 are composite. The three role references are single-column, and a role's
 * organization scope is closed by `private.guard_role_org_scope()` - a trigger - and by
 * the policies, not by the schema. So the copy names the references that ARE composite
 * rather than claiming they all are.
 */
const FEATURES = [
  {
    icon: Lock,
    title: "Isolation the schema carries",
    body: "Every tenant-owned table carries its organization, and the foreign keys that tie a row to another tenant's clinic or patient are composite - so a row pointing at another clinic is not representable, not merely hidden.",
  },
  {
    icon: KeyRound,
    title: "One permission rule",
    body: "Fifteen roles span the platform, the organization, the clinic and the clinical bench. A permission is held by a role, and the check is a single function the database runs - the interface asks it rather than deciding.",
  },
  {
    icon: Mail,
    title: "Invitations that name an address",
    body: "An invitation is issued to one address, expires, and is redeemed once. Only a digest of the token is stored, and redemption needs a confirmed account at that address.",
  },
  {
    icon: Clock,
    title: "The clinic's own time and money",
    body: "Time zone, currency and locale belong to the tenant. A clinic's day is computed in the clinic's own zone rather than the server's, from a canonical zone name rather than an abbreviation.",
  },
] as const;

export function FeatureHighlights() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-16">
      <h2 className="font-heading text-2xl font-semibold tracking-tight text-brand-navy">
        What the foundation gives you
      </h2>
      <ul className="mt-8 grid gap-6 sm:grid-cols-2">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <li
              key={feature.title}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6"
            >
              <div
                aria-hidden="true"
                className="flex size-10 items-center justify-center rounded-full bg-muted text-primary-ink"
              >
                <Icon className="size-5" />
              </div>
              <h3 className="font-heading text-base font-semibold text-foreground">
                {feature.title}
              </h3>
              <p className="text-sm text-muted-foreground">{feature.body}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

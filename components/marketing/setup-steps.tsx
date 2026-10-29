import { ArrowRight, Building2, Hospital, Users } from "lucide-react";

/**
 * The three-step setup: what onboarding this release actually does.
 *
 * WHY THE ORDER IS THIS ORDER. It is the path the product ships: the account Creates
 * their organization (title, slug, currency/locale and time zone), adds their first
 * clinic under it, and invites their team with roles and permissions - each step is a
 * real route in the signed-in app. "Multi-clinic" is NOT claimed: the product creates
 * exactly ONE clinic per organization today. "You'll be up and running in minutes"
 * from the reference design is dropped because no measurement backs a duration.
 */
const STEPS = [
  {
    icon: Building2,
    tone: "text-secondary",
    title: "Create your organisation",
    body: "Set up your main organisation, its address time zone and currency.",
  },
  {
    icon: Hospital,
    tone: "text-secondary",
    title: "Add your first clinic",
    body: "Register your clinic's location with its own canonical time zone.",
  },
  {
    icon: Users,
    tone: "text-primary-ink",
    title: "Invite your team",
    body: "Add team members and assign roles and permissions.",
  },
] as const;

export function SetupSteps() {
  return (
    <section className="bg-gradient-to-b from-accent/50 via-accent/25 to-background">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:py-24">
        <div className="mx-auto max-w-4xl text-center">
          <p className="text-xs font-semibold tracking-widest text-secondary uppercase">
            Get started today
          </p>
          <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-balance text-brand-navy sm:text-4xl">
            Set up your clinic in three simple steps
          </h2>
          <p className="mt-4 text-muted-foreground">
            Create your organisation, add your first clinic, and invite your team.
          </p>
        </div>
        <ol className="reveal-rise mt-14 grid gap-6 lg:grid-cols-3">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="relative flex items-center gap-5">
                <div className="relative flex h-full w-full flex-col items-center gap-3 rounded-2xl bg-card px-6 pt-10 pb-6 text-center shadow-lg shadow-brand-navy/5 transition duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:shadow-brand-navy/10 motion-reduce:transform-none motion-reduce:transition-none">
                  <span
                    aria-hidden="true"
                    className="absolute -top-5 -left-3 flex size-10 items-center justify-center rounded-full bg-primary font-heading text-base font-semibold text-primary-foreground shadow-lg shadow-primary/30"
                  >
                    {index + 1}
                  </span>
                  <Icon aria-hidden="true" className={`size-10 ${step.tone}`} strokeWidth={1.5} />
                  <h3 className="font-heading text-base font-semibold text-foreground">
                    {step.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </div>
                {index < STEPS.length - 1 ? (
                  <ArrowRight
                    aria-hidden="true"
                    className="absolute top-1/2 -right-4 z-10 hidden size-6 -translate-y-1/2 text-primary-ink lg:block"
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

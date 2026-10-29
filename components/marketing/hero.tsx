import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Building2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cross,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The hero: what the product is, in one sentence and one paragraph, beside a mock of
 * the signed-in shell.
 *
 * WHY THE COPY IS SO NARROW. The brief forbids claims that have not been verified, and
 * this release has no patient records, no appointments and no working payments - so the
 * copy says what is true today: the tenant model, the roles and the access control. Full
 * marketing copy is a later phase, and this is the visual foundation for it.
 *
 * THE MOCK IS A CONCEPT, NOT A SCREENSHOT. It draws the shell this release actually
 * ships - an organization dashboard with its members, roles and settings - and every
 * label on it names something the code can be asked about. It is aria-hidden because
 * the same facts are in the page's readable copy; no fabricated numbers or patient
 * data appear on it.
 */
const BADGES = [
  {
    icon: ShieldCheck,
    title: "Secure by design",
    body: "Built on Supabase with row-level security",
  },
  {
    icon: KeyRound,
    title: "Role-based access",
    body: "One permission rule the database runs",
  },
  {
    icon: Clock,
    title: "Your clinic's own zone & currency",
    body: "Time, money and locale belong to the tenant",
  },
] as const;

const MOCK_NAV = [
  { icon: LayoutDashboard, label: "Dashboard", active: true },
  { icon: Users, label: "People", active: false },
  { icon: Building2, label: "Clinics", active: false },
  { icon: Settings, label: "Settings", active: false },
] as const;

const ACTIVITY = [
  { body: "Team member joined the team", meta: "via invitation" },
  { body: "Team membership updated", meta: "role changed" },
  { body: "New membership permission added", meta: "role permissions" },
] as const;

const ACTIONS = [
  { title: "Invite team member", meta: "Send an invitation to your team" },
  { title: "Manage members", meta: "View and manage team members" },
  { title: "Organization settings", meta: "Time zone, currency and locale" },
] as const;

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-accent/60 via-background to-background">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 -right-32 size-[30rem] rounded-full bg-accent/70 blur-3xl motion-reduce:animate-none animate-float-slow"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 -left-24 size-80 rounded-full bg-secondary/10 blur-3xl motion-reduce:animate-none animate-float"
      />
      <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-6 pt-20 pb-14 lg:grid-cols-[1fr_1.05fr] lg:pt-24">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-1 text-xs font-medium text-primary-ink shadow-sm">
            Modern clinic management
          </p>
          <h1 className="mt-5 font-heading text-4xl font-semibold tracking-tight text-balance text-brand-navy sm:text-5xl lg:text-6xl">
            Simplify clinic operations, <span className="text-primary-ink">focus on care.</span>
          </h1>
          <p className="mt-5 max-w-prose text-base leading-relaxed text-muted-foreground">
            ClinicCore is a modern, secure and flexible platform that helps clinics organise their
            teams, manage access through roles, and build a strong foundation for high-quality care.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">
                Get started
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="#features">Explore the platform</Link>
            </Button>
          </div>
          <ul className="mt-10 grid gap-3 sm:grid-cols-3">
            {BADGES.map((badge) => {
              const Icon = badge.icon;
              return (
                <li
                  key={badge.title}
                  className="group flex items-start gap-3 rounded-2xl bg-card/70 p-3 shadow-sm transition-shadow duration-300 hover:shadow-lg hover:shadow-brand-navy/10 motion-reduce:transition-none"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-primary-ink transition-transform duration-300 group-hover:scale-110 motion-reduce:transform-none"
                  >
                    <Icon className="size-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-foreground">
                      {badge.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {badge.body}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div aria-hidden="true" className="relative hidden lg:block">
          <div className="pointer-events-none absolute -top-28 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-accent/80 blur-2xl motion-reduce:animate-none animate-float-slow" />
          <div className="relative rounded-2xl bg-card shadow-2xl shadow-brand-navy/10 transition-transform duration-500 hover:-translate-y-1 motion-reduce:transform-none motion-reduce:transition-none">
            <div className="flex items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2 pr-4">
                <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Cross className="size-3.5" />
                </span>
                <span className="text-sm font-semibold text-foreground">ClinicCore</span>
              </div>
              <div className="mx-1 flex flex-1 items-center gap-2 rounded-lg bg-muted px-3 py-2 text-muted-foreground">
                <Search className="size-4" />
                <span className="text-xs">Search...</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-full text-muted-foreground">
                  <Bell className="size-4" />
                </span>
                <span className="flex size-8 items-center justify-center rounded-full bg-muted">
                  <UserRound className="size-4 text-muted-foreground" />
                </span>
              </div>
            </div>

            <div className="flex gap-4 px-3 pb-3">
              <div className="w-44 shrink-0 rounded-xl bg-muted/60 p-3">
                <p className="flex items-center justify-between rounded-lg bg-background px-2 py-1.5 text-xs font-medium text-foreground shadow-sm">
                  Your organization
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </p>
                <ul className="mt-3 space-y-1">
                  {MOCK_NAV.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li
                        key={item.label}
                        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                          item.active
                            ? "bg-accent font-medium text-primary-ink"
                            : "text-muted-foreground"
                        }`}
                      >
                        <Icon className="size-3.5" />
                        {item.label}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-8 flex items-center gap-2 pt-3 text-xs text-muted-foreground">
                  <LogOut className="size-3.5" />
                  Sign out
                </p>
              </div>

              <div className="flex-1 rounded-xl bg-background p-4 shadow-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-heading text-base font-semibold text-foreground">Dashboard</p>
                  <p className="text-[11px] text-muted-foreground">Foundation release</p>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-card p-2.5 shadow-sm">
                    <Building2 className="size-4 text-primary-ink" />
                    <p className="mt-2 text-[11px] text-muted-foreground">Overview</p>
                    <p className="truncate text-[13px] font-semibold text-foreground">
                      Your organization
                    </p>
                  </div>
                  <div className="rounded-lg bg-card p-2.5 shadow-sm">
                    <Users className="size-4 text-primary-ink" />
                    <p className="mt-2 text-[11px] text-muted-foreground">Team members</p>
                    <p className="text-[13px] font-semibold text-foreground">Invited by address</p>
                  </div>
                  <div className="rounded-lg bg-card p-2.5 shadow-sm">
                    <ShieldCheck className="size-4 text-primary-ink" />
                    <p className="mt-2 text-[11px] text-muted-foreground">Your role</p>
                    <p className="text-[13px] font-semibold text-foreground">Role-based</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-[1.2fr_1fr] gap-2">
                  <div className="rounded-lg bg-card p-3 shadow-sm">
                    <p className="text-[13px] font-semibold text-foreground">Recent activity</p>
                    <ul className="mt-2.5 space-y-2.5">
                      {ACTIVITY.map((item) => (
                        <li key={item.body} className="flex items-start gap-2">
                          <span className="mt-0.5 flex size-4 items-center justify-center rounded-full bg-accent">
                            <Users className="size-2.5 text-primary-ink" />
                          </span>
                          <span>
                            <span className="block text-[11px] font-medium text-foreground">
                              {item.body}
                            </span>
                            <span className="block text-[10px] text-muted-foreground">
                              {item.meta}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-lg bg-card p-3 shadow-sm">
                    <p className="text-[13px] font-semibold text-foreground">Quick actions</p>
                    <ul className="mt-2.5 space-y-2.5">
                      {ACTIONS.map((item) => (
                        <li key={item.title} className="flex items-center gap-2">
                          <span className="flex size-4 items-center justify-center rounded-md bg-accent">
                            <ChevronRight className="size-2.5 text-primary-ink" />
                          </span>
                          <span className="truncate text-[11px] font-medium text-foreground">
                            {item.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

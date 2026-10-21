import { PageHeader } from "@/components/shared/page-header";
import { OnboardingForm } from "./form";

/**
 * The zero-membership screen: "create your organization".
 *
 * WHY IT IS A SEPARATE COMPONENT AND NOT THE PAGE. The shell renders it when the user
 * belongs to nothing, and the page at `/app/onboarding` renders it when the user comes
 * here directly. Both must show the same thing, so there is one component and the page
 * is a one-line wrapper around it.
 *
 * WHY IT IS NOT THE SHELL. There is no tenant to render a sidebar for, and a sidebar
 * full of links that lead nowhere is worse than no sidebar.
 */
export function OnboardingPanel() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-lg space-y-6">
        <PageHeader
          title="Create your organization"
          description="Your organization is the clinic's home in ClinicCore. It holds your clinics, your staff and their permissions."
        />
        <OnboardingForm />
      </div>
    </main>
  );
}

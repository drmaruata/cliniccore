import { redirect } from "next/navigation";

/**
 * `/app` is the entry point of the signed-in application, and the dashboard is where
 * the work is. A user with no organization is answered by the shell, which renders the
 * onboarding screen instead of this page - so the redirect below only runs for a user
 * who has a tenant.
 */
export default function AppIndexPage() {
  redirect("/app/dashboard");
}

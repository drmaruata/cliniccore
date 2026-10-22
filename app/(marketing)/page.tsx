import { FeatureHighlights } from "@/components/marketing/feature-highlights";
import { Hero } from "@/components/marketing/hero";

/**
 * The landing page.
 *
 * THIS FILE REPLACED THE ROOT `app/page.tsx`, and it had to: a route group is pathless,
 * so `app/(marketing)/page.tsx` serves `/` - and a second page serving `/` is a build
 * conflict, not a second route.
 */
export default function MarketingHomePage() {
  return (
    <>
      <Hero />
      <FeatureHighlights />
    </>
  );
}

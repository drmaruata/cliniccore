import { CtaBanner } from "@/components/marketing/cta-banner";
import { FeatureHighlights } from "@/components/marketing/feature-highlights";
import { Hero } from "@/components/marketing/hero";
import { RoadmapSection } from "@/components/marketing/roadmap";
import { SecurityFoundation } from "@/components/marketing/security-foundation";
import { SetupSteps } from "@/components/marketing/setup-steps";

/**
 * The landing page, composed in the reference design's order: hero, feature grid,
 * security split, three-step setup, roadmap, closing banner.
 *
 * THIS FILE REPLACED THE ROOT `app/page.tsx`, and it had to: a route group is pathless,
 * so `app/(marketing)/page.tsx` serves `/` - and a second page serving `/` is a build
 * conflict, not a second route.
 *
 * THE REFERENCE DESIGN'S TESTIMONIALS ARE NOT HERE, ON PURPOSE. The brief forbids
 * claims that have not been verified, and there are no customers to quote yet - an
 * invented "Dr Rajesh Kumar" or a five-star rating would be a fabrication on a medical
 * product's home page. The trust sections that replace it are the security split and
 * the roadmap, which the codebase can be asked about.
 */
export default function MarketingHomePage() {
  return (
    <>
      <Hero />
      <FeatureHighlights />
      <SecurityFoundation />
      <SetupSteps />
      <RoadmapSection />
      <CtaBanner />
    </>
  );
}

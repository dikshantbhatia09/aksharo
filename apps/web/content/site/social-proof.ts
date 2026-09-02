/**
 * Home page social proof (A24 brief: "social proof placeholders — no
 * fabricated testimonials"). 13-launch-plan.md's day-1-30 plan is
 * founder-led seeding of 60 creators; nobody has posted yet, so this section
 * states the plan honestly instead of inventing a quote or a logo.
 */

export interface SocialProofStat {
  readonly label: string;
  readonly value: string;
}

export const SOCIAL_PROOF_STATS: readonly SocialProofStat[] = [
  { label: "Caption styles shipped", value: "30+" },
  { label: "Languages routed", value: "22 Indian + 90 global" },
  { label: "NLEs, one credit pool", value: "Premiere Pro · After Effects · Resolve" },
];

export const SOCIAL_PROOF_NOTE =
  "We're onboarding our first founding creators now. Real numbers and stories replace this note as they come in — we don't publish a testimonial or a logo we can't back up.";

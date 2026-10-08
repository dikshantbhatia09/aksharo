import type { Metadata } from "next";
import { BRAND } from "@montaj/config";

import { OpusHero } from "./_components/opus-hero";
import { SocialProofBar } from "./_components/social-proof-bar";
import { FeatureTabs } from "./_components/feature-tabs";
import { BentoGrid } from "./_components/bento-grid";
import { EditorShowcase } from "./_components/editor-showcase";
import { HookScoreShowcase } from "./_components/hook-score-showcase";
import { WorkflowAutomation } from "./_components/workflow-automation";
import { TestimonialsWall } from "./_components/testimonials-wall";
import { FaqAccordion } from "./_components/faq-accordion";
import { CtaBanner } from "./_components/cta-banner";

export const metadata: Metadata = {
  title: `${BRAND.name} — 1 long video, 10 viral clips. Create 10x faster.`,
  description:
    "Turn long podcasts, YouTube videos, and webinars into high-retention shorts, reels, and TikToks with AI virality scoring, active speaker tracking, and Hinglish dynamic captions.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${BRAND.name} — 1 long video, 10 viral clips. Create 10x faster.`,
    description:
      "Turn long podcasts, YouTube videos, and webinars into high-retention shorts, reels, and TikToks with AI virality scoring, active speaker tracking, and Hinglish dynamic captions.",
    url: "/",
    type: "website",
  },
};

export default function HomePage(): React.JSX.Element {
  return (
    <div className="relative overflow-hidden bg-bg-0 text-fg-0 selection:bg-accent selection:text-white">
      {/* Hero Section */}
      <OpusHero />

      {/* Social Proof & Creator Wall */}
      <SocialProofBar />

      {/* Interactive Feature Switcher Suite */}
      <FeatureTabs />

      {/* Bento Grid AI Models */}
      <BentoGrid />

      {/* Realistic AI Editor Showcase */}
      <EditorShowcase />

      {/* Dedicated Hook Score & Virality Breakdown */}
      <HookScoreShowcase />

      {/* Workflow Autopilot */}
      <WorkflowAutomation />

      {/* Creator Testimonials / Wall of Love */}
      <TestimonialsWall />

      {/* Expandable FAQ Accordion */}
      <FaqAccordion />

      {/* High-Impact Bottom CTA */}
      <CtaBanner />
    </div>
  );
}

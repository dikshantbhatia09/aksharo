"use client";

import { Flame, Sparkles, TrendingUp, AlertCircle, CheckCircle2, ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@montaj/ui";
import { AUTH_NAV } from "@/content/site/nav";

interface HookTier {
  readonly range: string;
  readonly category: string;
  readonly badgeColor: string;
  readonly borderColor: string;
  readonly bgColor: string;
  readonly description: string;
  readonly characteristics: readonly string[];
  readonly aiAction: string;
}

const HOOK_TIERS: readonly HookTier[] = [
  {
    range: "90 – 100",
    category: "Viral Gold (Top Tier)",
    badgeColor: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
    borderColor: "border-emerald-500/30",
    bgColor: "bg-emerald-950/10",
    description:
      "Instant pattern interruption in the opening 3 seconds with intense curiosity or bold claims. 85%+ retention predicted.",
    characteristics: [
      "Immediate question or shocking paradox",
      "Fast 140+ WPM speech pacing without filler pauses",
      "High emotional resonance and immediate visual change",
    ],
    aiAction: "Ready to export & schedule directly to Shorts, Reels & TikTok.",
  },
  {
    range: "70 – 89",
    category: "High Performer (Mid Tier)",
    badgeColor: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    borderColor: "border-amber-500/30",
    bgColor: "bg-amber-950/10",
    description:
      "Solid storytelling, valuable educational insight, and consistent narrative flow. Strong watch-time performer.",
    characteristics: [
      "Engaging premise that pays off within 45 seconds",
      "Ideal for tutorial walkthroughs and founder stories",
      "Moderate initial hook, very strong mid-segment retention",
    ],
    aiAction: "Aksharo suggests optional kinetic B-roll to boost initial 3-second hook.",
  },
  {
    range: "< 70",
    category: "Needs Hook Polish (Low Tier)",
    badgeColor: "bg-purple-500/20 text-purple-300 border-purple-500/30",
    borderColor: "border-purple-500/30",
    bgColor: "bg-purple-950/10",
    description:
      "Valuable conversation buried behind a slow warm-up or lengthy pleasantry. High drop-off risk without restructuring.",
    characteristics: [
      "Opening starts with greetings ('Hey guys, welcome back')",
      "Key insight delayed past the first 10 seconds",
      "Viewer likely scrolls before reaching the value",
    ],
    aiAction: "AI Hook Remediation automatically moves the punchline to second 0.",
  },
];

export function HookScoreShowcase(): React.JSX.Element {
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Section Header */}
      <div className="flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3.5 py-1 text-xs font-semibold text-amber-300">
          <Flame className="size-3.5" />
          <span>TRIBE NEURO-ATTENTION HOOK ENGINE</span>
        </div>

        <h2 className="text-fg-0 mt-5 text-3xl font-bold tracking-tight sm:text-5xl max-w-3xl leading-[1.15]">
          Know if your clip will go viral before you post
        </h2>

        <p className="text-fg-1 mt-4 text-base sm:text-lg max-w-2xl leading-relaxed">
          Aksharo evaluates every cut through our neuro-attention model, benchmarking opening hooks,
          emotional dopamine arcs, and narrative pacing.
        </p>
      </div>

      {/* 3 Tier Cards */}
      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {HOOK_TIERS.map((tier) => (
          <div
            key={tier.category}
            className={`flex flex-col justify-between rounded-3xl border ${tier.borderColor} ${tier.bgColor} p-6 sm:p-8 backdrop-blur-xl transition-all duration-300 hover:scale-[1.02]`}
          >
            <div>
              <div className="flex items-center justify-between">
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-bold ${tier.badgeColor}`}
                >
                  Score {tier.range}
                </span>
                <span className="font-mono text-xs text-fg-2">Benchmark</span>
              </div>

              <h3 className="text-fg-0 mt-5 text-xl font-bold tracking-tight">{tier.category}</h3>

              <p className="text-fg-1 mt-3 text-xs sm:text-sm leading-relaxed">{tier.description}</p>

              <div className="mt-6 space-y-2 border-t border-white/10 pt-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-2 block">
                  Key Metrics:
                </span>
                {tier.characteristics.map((point) => (
                  <div key={point} className="flex items-start gap-2 text-xs text-fg-1">
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400 mt-0.5" />
                    <span>{point}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-8 rounded-xl border border-white/10 bg-black/40 p-3 text-xs">
              <span className="font-semibold text-fg-0 block mb-1">AI Recommendation:</span>
              <span className="text-fg-2 leading-relaxed block">{tier.aiAction}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Action Footer */}
      <div className="mt-12 flex justify-center">
        <Button variant="secondary" size="lg" asChild>
          <Link href={AUTH_NAV.getStarted.href} className="flex items-center gap-2">
            <span>Score Your Video Now</span>
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </section>
  );
}


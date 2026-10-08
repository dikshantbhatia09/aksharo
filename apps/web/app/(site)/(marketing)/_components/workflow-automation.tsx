"use client";

import { RefreshCw, Wand2, Calendar, Share2, Layers, CheckCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@montaj/ui";
import { AUTH_NAV } from "@/content/site/nav";

interface AutomationStep {
  readonly step: string;
  readonly title: string;
  readonly description: string;
  readonly icon: typeof Wand2;
}

const STEPS: readonly AutomationStep[] = [
  {
    step: "01",
    title: "Paste URL or Upload Footage",
    description:
      "Drop any YouTube link, podcast audio, Zoom recording, or raw MP4/MOV file. Aksharo automatically acquires and probes your media in seconds.",
    icon: Wand2,
  },
  {
    step: "02",
    title: "AI Finds Hooks & Reframes",
    description:
      "Our multimodal models score engagement, transcribe Hinglish audio with phoneme timing, and reframe subjects to vertical 9:16.",
    icon: Layers,
  },
  {
    step: "03",
    title: "Apply Brand Kit & Auto-Publish",
    description:
      "Apply custom brand fonts, logos, animated captions, and review proposals. Publish directly to Shorts, Reels, and TikTok with viral hooks.",
    icon: Share2,
  },
];

export function WorkflowAutomation(): React.JSX.Element {
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Section Header */}
      <div className="flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3.5 py-1 text-xs font-semibold text-cyan-300">
          <RefreshCw className="size-3.5 animate-spin [animation-duration:8s]" />
          <span>WORKFLOW AUTOMATION</span>
        </div>

        <h2 className="text-fg-0 mt-5 text-3xl font-bold tracking-tight sm:text-5xl max-w-3xl leading-[1.15]">
          Your video creation process — now on autopilot
        </h2>

        <p className="text-fg-1 mt-4 text-base sm:text-lg max-w-2xl leading-relaxed">
          Create and publish videos 10x faster with Aksharo. Turn one 60-minute podcast into an entire
          month of daily viral shorts in under 10 minutes.
        </p>
      </div>

      {/* 3 Step Cards */}
      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {STEPS.map((step) => {
          const Icon = step.icon;
          return (
            <div
              key={step.step}
              className="relative flex flex-col justify-between overflow-hidden rounded-3xl border border-white/10 bg-[#14121a] p-8 backdrop-blur-xl transition-all duration-300 hover:border-white/20 hover:bg-[#1a1723]"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-2xl font-black text-cyan-400">{step.step}</span>
                  <div className="rounded-xl border border-white/10 bg-white/5 p-2.5">
                    <Icon className="size-5 text-cyan-300" />
                  </div>
                </div>

                <h3 className="text-fg-0 mt-6 text-xl font-bold tracking-tight">{step.title}</h3>

                <p className="text-fg-1 mt-3 text-sm leading-relaxed">{step.description}</p>
              </div>

              <div className="mt-8 flex items-center gap-2 text-xs font-medium text-emerald-400">
                <CheckCircle className="size-4 shrink-0" />
                <span>Zero manual keyframing required</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}


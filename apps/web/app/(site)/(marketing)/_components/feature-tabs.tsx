"use client";

import { useState } from "react";
import {
  Sparkles,
  Crop,
  Subtitles,
  Film,
  Scissors,
  Share2,
  TrendingUp,
  Play,
  CheckCircle2,
  Zap,
  Sliders,
  Flame,
} from "lucide-react";
import { cn } from "@/lib/utils";

type FeatureKey = "virality" | "reframe" | "captions" | "broll" | "editor" | "scheduler";

interface FeatureTab {
  readonly id: FeatureKey;
  readonly label: string;
  readonly icon: typeof Sparkles;
  readonly title: string;
  readonly description: string;
  readonly tag: string;
}

const TABS: readonly FeatureTab[] = [
  {
    id: "virality",
    label: "AI Virality Score",
    icon: Sparkles,
    title: "Predict virality before publishing with neuro-attention hook scoring",
    description:
      "Aksharo analyzes narrative tension, opening 3-second hook strength, and emotional dopamine peaks to rank every moment from 0 to 100.",
    tag: "98% Accuracy",
  },
  {
    id: "reframe",
    label: "AI Auto-Reframe",
    icon: Crop,
    title: "Keep active speakers centered at 9:16 with YuNet neural tracking",
    description:
      "No manual pan-and-scan keyframing. Automatically tracks faces, switches between active speakers, or creates dynamic split-screens for interviews.",
    tag: "60 FPS Neural Tracking",
  },
  {
    id: "captions",
    label: "AI Dynamic Captions",
    icon: Subtitles,
    title: "Hinglish-accurate animated karaoke captions that 10x watch time",
    description:
      "Phoneme-aligned word timing in English, Hindi, and Hinglish. 30+ viral kinetic styles with auto-emojis, neon highlights, and custom creator fonts.",
    tag: "99.4% Phoneme Alignment",
  },
  {
    id: "broll",
    label: "AI B-Roll & Visuals",
    icon: Film,
    title: "Contextual B-roll cutaways and sound effects generated automatically",
    description:
      "Aksharo listens to your spoken concepts and overlays relevant high-definition B-roll footage, sound effects, and kinetic stickers at the exact right moment.",
    tag: "Zero Manual Skimming",
  },
  {
    id: "editor",
    label: "AI Clip Editor",
    icon: Scissors,
    title: "Edit video like text: delete words from the transcript to cut footage",
    description:
      "Trim fluff, remove filler words ('um', 'uh', dead silences) with 1 click, and rearrange sections effortlessly on a synchronized timeline.",
    tag: "Word-Level Precision",
  },
  {
    id: "scheduler",
    label: "AI Social Autopilot",
    icon: Share2,
    title: "Publish to YouTube Shorts, Reels, and TikTok in one unified click",
    description:
      "Generate viral titles, descriptions, and hashtags tailored for each platform algorithm, then schedule automated posting across all channels.",
    tag: "Multi-Platform Dispatch",
  },
];

export function FeatureTabs(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<FeatureKey>("virality");
  const active = TABS.find((tab) => tab.id === activeTab) ?? TABS[0]!;

  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Feature Switcher Pills Bar */}
      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isSelected = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "group flex items-center gap-2 rounded-full border px-4 py-2.5 text-xs font-semibold transition-all duration-200 sm:text-sm",
                isSelected
                  ? "border-white/30 bg-white text-black shadow-[0_0_20px_rgba(255,255,255,0.25)]"
                  : "border-white/10 bg-[#16141c]/80 text-fg-2 hover:border-white/20 hover:bg-[#201d27] hover:text-fg-0",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0 transition-transform group-hover:scale-110",
                  isSelected ? "text-black" : "text-fg-2 group-hover:text-fg-0",
                )}
                strokeWidth={2}
              />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Main Interactive Showcase Card */}
      <div className="mt-12 overflow-hidden rounded-3xl border border-white/10 bg-[#110f16]/90 p-6 sm:p-10 shadow-2xl backdrop-blur-xl">
        <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
          {/* Left column: Feature info & highlights */}
          <div className="flex flex-col lg:col-span-5">
            <div className="inline-flex items-center gap-2 self-start rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent-300">
              <Zap className="size-3.5" />
              <span>{active.tag}</span>
            </div>

            <h3 className="text-fg-0 mt-5 text-2xl font-bold tracking-tight sm:text-3xl leading-snug">
              {active.title}
            </h3>

            <p className="text-fg-1 mt-4 text-sm sm:text-base leading-relaxed">
              {active.description}
            </p>

            {/* Micro feature checkmarks */}
            <div className="mt-8 space-y-3">
              {activeTab === "virality" && (
                <>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Opening 3-second hook strength prediction</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Story arc & emotional tension scoring</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>AI suggestions on re-hooking lower-scored segments</span>
                  </div>
                </>
              )}

              {activeTab === "reframe" && (
                <>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>YuNet neural face detection & continuous tracking</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Dynamic 2-speaker split-screen for podcast debates</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Manual framing overrides when you want exact control</span>
                  </div>
                </>
              )}

              {activeTab === "captions" && (
                <>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Hinglish & Indic phoneme-accurate transcription</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>30+ animated karaoke styles (Punch Pop, Hormozi, Neon)</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Automatic emoji popups & keyword highlight colors</span>
                  </div>
                </>
              )}

              {activeTab === "broll" && (
                <>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>AI contextual B-roll matched to spoken transcript words</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Kinetic stickers, sound effects, and zoom punch-ins</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Custom brand asset upload for intros, outros & logos</span>
                  </div>
                </>
              )}

              {activeTab === "editor" && (
                <>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Word-by-word transcript editor: strike through to cut</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>1-click silence & filler word removal</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Export clean MP4s, or export SRT / VTT subtitle files</span>
                  </div>
                </>
              )}

              {activeTab === "scheduler" && (
                <>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>1-click publishing to YouTube Shorts, Reels & TikTok</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>AI generated viral titles, hooks, and hashtags</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs sm:text-sm text-fg-1">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
                    <span>Automated content queue & cross-platform calendar</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Right column: Interactive Visual Simulation */}
          <div className="relative lg:col-span-7">
            <div className="relative rounded-2xl border border-white/10 bg-[#16141d] p-4 sm:p-6 shadow-inner">
              {/* Dynamic View rendering depending on selected tab */}
              {activeTab === "virality" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <div className="flex items-center gap-2">
                      <Flame className="size-5 text-amber-400 animate-pulse" />
                      <span className="text-fg-0 font-semibold text-sm">Clip Virality Score Breakdown</span>
                    </div>
                    <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-bold text-emerald-400">
                      Score: 98 / 100
                    </span>
                  </div>

                  {/* Clip card 1 */}
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-emerald-400">#1 Top Clip · 0:14 – 0:58</span>
                      <span className="text-xs text-fg-2">Viral Probability: 94%</span>
                    </div>
                    <p className="text-fg-0 mt-2 text-sm font-medium">
                      &ldquo;The single habit that doubled our revenue in 90 days...&rdquo;
                    </p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded-lg bg-white/5 p-2">
                        <span className="text-fg-2 block text-[10px]">Hook Strength</span>
                        <span className="text-fg-0 font-bold">98%</span>
                      </div>
                      <div className="rounded-lg bg-white/5 p-2">
                        <span className="text-fg-2 block text-[10px]">Engagement Arc</span>
                        <span className="text-fg-0 font-bold">96%</span>
                      </div>
                      <div className="rounded-lg bg-white/5 p-2">
                        <span className="text-fg-2 block text-[10px]">Pacing Flow</span>
                        <span className="text-fg-0 font-bold">97%</span>
                      </div>
                    </div>
                  </div>

                  {/* Clip card 2 */}
                  <div className="rounded-xl border border-white/10 bg-white/5 p-4 opacity-80">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-fg-1">#2 Solid Performer · 1:20 – 1:55</span>
                      <span className="text-xs text-fg-2">Viral Probability: 84%</span>
                    </div>
                    <p className="text-fg-0 mt-2 text-sm font-medium">
                      &ldquo;Why most entrepreneurs fail before month three...&rdquo;
                    </p>
                  </div>
                </div>
              )}

              {activeTab === "reframe" && (
                <div className="space-y-4">
                  <div className="relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-neutral-900 flex items-center justify-center">
                    {/* 16:9 widescreen with 9:16 center crop box */}
                    <div className="absolute inset-0 bg-gradient-to-r from-neutral-950/80 via-transparent to-neutral-950/80" />
                    <div className="relative h-full w-[40%] rounded-md border-2 border-dashed border-emerald-400 bg-emerald-500/10 flex flex-col items-center justify-between p-3">
                      <div className="self-start rounded bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-black uppercase">
                        9:16 Auto-Crop
                      </div>
                      <div className="rounded-full border border-emerald-400 bg-emerald-400/20 px-2 py-0.5 text-[10px] text-emerald-300 font-medium">
                        YuNet Face Locked: Speaker 1
                      </div>
                      <div className="text-[10px] text-fg-2">Centering active voice</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-fg-2">
                    <span>Source: 16:9 4K Video</span>
                    <span className="text-emerald-400 font-medium">Reframe: 9:16 Vertical HD</span>
                  </div>
                </div>
              )}

              {activeTab === "captions" && (
                <div className="space-y-4">
                  <div className="flex flex-col items-center justify-center rounded-xl bg-neutral-950 p-8 text-center min-h-[220px]">
                    <div className="inline-flex rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold text-accent-300 mb-4">
                      Style: Punch-Pop Neon
                    </div>
                    <p className="text-2xl font-black uppercase tracking-tight text-white">
                      THIS IS HOW YOU <span className="text-amber-400 bg-amber-400/20 px-1 rounded">WIN</span> ON
                    </p>
                    <p className="text-3xl font-black uppercase tracking-tight text-emerald-400 mt-1">
                      YOUTUBE SHORTS 🚀
                    </p>
                    <p className="text-xs text-fg-2 mt-4 font-mono">
                      Phoneme sync: 0.12s · Hinglish accurate · Auto-emoji injected
                    </p>
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    {["Punch Pop", "Hormozi", "Devanagari", "Beast", "Cinematic"].map((style, i) => (
                      <span
                        key={style}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[11px] font-medium border",
                          i === 0
                            ? "border-accent bg-accent/20 text-accent-200"
                            : "border-white/10 bg-white/5 text-fg-2",
                        )}
                      >
                        {style}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === "broll" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="relative aspect-video rounded-xl overflow-hidden border border-white/10 bg-neutral-900 p-3 flex flex-col justify-between">
                      <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white self-start">
                        Main Footage (Dialogue)
                      </span>
                      <p className="text-xs text-fg-1 font-medium">&ldquo;...when you analyze financial charts...&rdquo;</p>
                    </div>
                    <div className="relative aspect-video rounded-xl overflow-hidden border border-accent/40 bg-accent-950/20 p-3 flex flex-col justify-between">
                      <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-white font-bold self-start">
                        Auto B-Roll Insert
                      </span>
                      <p className="text-xs text-accent-200 font-semibold">[Stock 4K: Candlestick Chart 📈]</p>
                    </div>
                  </div>
                  <div className="rounded-lg bg-white/5 p-3 text-xs text-fg-2 flex items-center justify-between">
                    <span>⚡ SFX Auto-Synced: Whoosh.mp3 + Cash-Register.mp3</span>
                    <span className="text-accent-300 font-medium">Synced in 0.4s</span>
                  </div>
                </div>
              )}

              {activeTab === "editor" && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-white/10 bg-neutral-950 p-4 font-sans text-sm">
                    <div className="flex items-center justify-between text-xs text-fg-2 border-b border-white/10 pb-2 mb-3">
                      <span>Transcript Edit Mode</span>
                      <span className="text-emerald-400">✂️ 2 words removed (-1.4s)</span>
                    </div>
                    <p className="text-fg-0 leading-relaxed">
                      What would you do for your{" "}
                      <span className="text-emerald-400 font-bold bg-emerald-500/10 px-1 rounded">
                        marketing strategy
                      </span>{" "}
                      if you were{" "}
                      <span className="line-through text-red-400/80 bg-red-950/30 px-1 rounded">
                        you know like
                      </span>{" "}
                      starting fresh today? The first thing is figuring out your{" "}
                      <span className="text-amber-400 font-bold bg-amber-500/10 px-1 rounded">
                        hook
                      </span>
                      .
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-xs text-fg-2">
                    <span>Timeline: 0:42.5 / 1:00.0</span>
                    <span className="text-fg-1">Audio Waveform Synced</span>
                  </div>
                </div>
              )}

              {activeTab === "scheduler" && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-white/10 bg-neutral-950 p-4">
                    <div className="flex items-center justify-between mb-3 text-xs">
                      <span className="font-semibold text-fg-0">Scheduled Dispatch: Tomorrow 6:00 PM</span>
                      <span className="text-emerald-400 font-medium">Ready</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg border border-white/10 bg-white/5 p-2.5 text-center">
                        <span className="text-xs font-bold text-white block">YouTube Shorts</span>
                        <span className="text-[10px] text-emerald-400">Optimized Title & Tags</span>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-white/5 p-2.5 text-center">
                        <span className="text-xs font-bold text-white block">Instagram Reels</span>
                        <span className="text-[10px] text-emerald-400">Trending Audio Tag</span>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-white/5 p-2.5 text-center">
                        <span className="text-xs font-bold text-white block">TikTok</span>
                        <span className="text-[10px] text-emerald-400">Viral Description</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-fg-2 text-center">
                    1-Click Auto-Publish across connected creator accounts
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


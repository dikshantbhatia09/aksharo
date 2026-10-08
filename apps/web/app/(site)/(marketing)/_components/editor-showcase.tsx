"use client";

import {
  Scissors,
  Plus,
  Sliders,
  Type,
  Upload,
  Sparkles,
  Music,
  Maximize2,
  Volume2,
  Trash2,
  ZoomIn,
  Flame,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@montaj/ui";
import { AUTH_NAV } from "@/content/site/nav";

export function EditorShowcase(): React.JSX.Element {
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Section Header */}
      <div className="flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-pink-500/30 bg-pink-500/10 px-3.5 py-1 text-xs font-semibold text-pink-300">
          <Scissors className="size-3.5" />
          <span>AI EDITOR</span>
        </div>

        <h2 className="text-fg-0 mt-5 text-3xl font-bold tracking-tight sm:text-5xl max-w-3xl leading-[1.15]">
          AI that edits with you, not just for you
        </h2>

        <p className="text-fg-1 mt-4 text-base sm:text-lg max-w-2xl leading-relaxed">
          Take full creative control, or let our AI take over. Either way, editing long videos into
          viral shorts is fast, intuitive, and fun.
        </p>
      </div>

      {/* Editor Frame Mockup */}
      <div className="mt-14 overflow-hidden rounded-3xl border border-white/12 bg-[#0d0c10] shadow-[0_20px_70px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
        {/* Editor Chrome Topbar */}
        <div className="flex items-center justify-between border-b border-white/10 bg-[#141219] px-6 py-3">
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-red-500/80" />
            <span className="size-3 rounded-full bg-amber-500/80" />
            <span className="size-3 rounded-full bg-emerald-500/80" />
            <span className="ml-4 font-mono text-xs text-fg-2">
              Aksharo Studio · Episode_42_Clip_01.mp4
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium text-fg-2">
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="size-2 rounded-full bg-emerald-400 animate-ping" />
              Auto-saved
            </span>
            <Button variant="primary" size="sm" asChild>
              <Link href={AUTH_NAV.getStarted.href}>Export Clean MP4</Link>
            </Button>
          </div>
        </div>

        {/* Editor Workspace 3-Column Layout */}
        <div className="grid min-h-[440px] grid-cols-1 md:grid-cols-12 divide-y md:divide-y-0 md:divide-x divide-white/10">
          {/* Column 1: Transcript Text Editor (5 cols) */}
          <div className="p-6 md:col-span-5 flex flex-col justify-between bg-[#110f16]/60">
            <div>
              <div className="flex items-center justify-between pb-4 border-b border-white/8">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-fg-1 hover:bg-white/10 transition-colors"
                >
                  <Plus className="size-3.5" />
                  <span>Add a section</span>
                </button>
                <span className="text-[11px] font-mono text-emerald-400">Hook Strength: 98%</span>
              </div>

              <div className="mt-4 space-y-3 font-sans text-xs sm:text-sm leading-relaxed text-fg-1">
                <p>
                  &ldquo;What would you do for your{" "}
                  <span className="text-emerald-400 font-semibold bg-emerald-500/10 px-1 py-0.5 rounded">
                    marketing strategy
                  </span>{" "}
                  launching a new product?
                </p>
                <p>
                  The first thing I am doing is figuring out what type of{" "}
                  <span className="text-amber-400 font-semibold bg-amber-500/10 px-1 py-0.5 rounded">
                    creator
                  </span>{" "}
                  I need to be. Right now, am I gonna be YouTube, LinkedIn, what&apos;s my{" "}
                  <span className="text-emerald-400 font-semibold bg-emerald-500/10 px-1 py-0.5 rounded">
                    product
                  </span>
                  ? What&apos;s my market?&rdquo;
                </p>
                <p className="text-fg-2 text-xs">
                  &ldquo;And I gotta start creating and I gotta create videos on the{" "}
                  <span className="text-emerald-400 font-semibold bg-emerald-500/10 px-1 py-0.5 rounded">
                    daily
                  </span>
                  ...&rdquo;
                </p>
              </div>
            </div>

            <div className="mt-6 pt-3 border-t border-white/8 flex items-center justify-between text-[11px] text-fg-2">
              <span>💡 Tip: Select any word and hit Delete to trim footage</span>
              <span className="font-mono text-fg-1">0:32 / 0:58</span>
            </div>
          </div>

          {/* Column 2: 9:16 Vertical Video Canvas (5 cols) */}
          <div className="p-6 md:col-span-5 flex flex-col items-center justify-center bg-[#0a090d]">
            {/* Aspect & Reframe Header */}
            <div className="mb-4 flex items-center gap-4 text-xs text-fg-2">
              <span className="font-semibold text-fg-0">📱 9:16</span>
              <span>Layout: Fill</span>
              <span className="text-emerald-400 font-medium">YuNet Track: ON</span>
            </div>

            {/* Smartphone Stage Mockup */}
            <div className="relative aspect-[9/16] w-[210px] sm:w-[240px] overflow-hidden rounded-2xl border-2 border-white/15 bg-neutral-900 shadow-2xl">
              {/* Fake video frame representation */}
              <div className="absolute inset-0 bg-gradient-to-b from-neutral-800 via-neutral-900 to-black flex flex-col justify-between p-4">
                {/* Active Speaker Tag */}
                <div className="self-start rounded-full bg-black/60 backdrop-blur-md border border-white/10 px-2.5 py-0.5 text-[10px] font-medium text-white flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-emerald-400" />
                  <span>Tomas (Active)</span>
                </div>

                {/* Animated Dynamic Captions Mockup */}
                <div className="text-center">
                  <span className="inline-block rounded-md bg-amber-400 px-2 py-0.5 text-xs font-black uppercase tracking-wider text-black shadow-lg">
                    LAUNCHING A
                  </span>
                  <div className="text-sm font-black uppercase tracking-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] mt-0.5">
                    NEW PRODUCT 🚀
                  </div>
                </div>

                {/* Bottom Sound / View Pill */}
                <div className="flex items-center justify-between text-[10px] text-fg-2">
                  <span className="rounded bg-black/50 px-1.5 py-0.5">1080x1920</span>
                  <span className="font-mono text-emerald-400 font-semibold">SCORE 98</span>
                </div>
              </div>
            </div>
          </div>

          {/* Column 3: Toolkit Sidebar (2 cols) */}
          <div className="p-4 md:col-span-2 flex flex-col items-center gap-3 bg-[#131118]/80 text-center">
            <span className="text-[11px] font-semibold text-fg-2 uppercase tracking-wider mb-1">
              Tools
            </span>

            {[
              { label: "AI Enhance", icon: Sparkles, active: false },
              { label: "Captions", icon: Type, active: true },
              { label: "AI Hook", icon: Flame, active: false },
              { label: "B-Roll", icon: Maximize2, active: false },
              { label: "Music & SFX", icon: Music, active: false },
              { label: "Assets", icon: Upload, active: false },
            ].map((tool) => {
              const Icon = tool.icon;
              return (
                <button
                  key={tool.label}
                  type="button"
                  className={`w-full flex flex-col items-center gap-1 rounded-xl p-2.5 text-[11px] font-medium transition-all ${
                    tool.active
                      ? "border border-accent/40 bg-accent/15 text-accent-200"
                      : "border border-transparent text-fg-2 hover:bg-white/5 hover:text-fg-0"
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="text-[10px]">{tool.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Bottom Multi-Track Timeline Bar */}
        <div className="border-t border-white/10 bg-[#121017] p-4">
          <div className="flex items-center justify-between text-xs text-fg-2 pb-2">
            <div className="flex items-center gap-3">
              <button type="button" className="hover:text-fg-0 transition-colors">
                Hide timeline
              </button>
              <Trash2 className="size-3.5 hover:text-red-400 cursor-pointer" />
              <Volume2 className="size-3.5 hover:text-fg-0 cursor-pointer" />
            </div>
            <div className="flex items-center gap-2">
              <ZoomIn className="size-3.5" />
              <span className="font-mono text-[11px]">100% Zoom</span>
            </div>
          </div>

          {/* Waveform track simulation */}
          <div className="relative mt-2 h-10 w-full overflow-hidden rounded-lg border border-white/10 bg-[#09080c] flex items-center px-2">
            {/* Waveform bars */}
            <div className="flex h-6 w-full items-center gap-1 opacity-60">
              {Array.from({ length: 64 }).map((_, i) => (
                <div
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  className="w-1 rounded-full bg-accent"
                  style={{
                    height: `${Math.max(15, ((i * 37) % 100))}%`,
                    opacity: i > 25 ? 0.35 : 0.9,
                  }}
                />
              ))}
            </div>

            {/* Playhead marker */}
            <div className="absolute left-[38%] inset-y-0 w-0.5 bg-white shadow-[0_0_8px_white]">
              <div className="size-2 -ml-[3px] rounded-full bg-white" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


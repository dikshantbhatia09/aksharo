"use client";

import { Sparkles, ScanFace, Languages, Cpu, CheckCircle, ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@montaj/ui";
import { AUTH_NAV } from "@/content/site/nav";

export function BentoGrid(): React.JSX.Element {
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Section Header */}
      <div className="flex flex-col items-center text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3.5 py-1 text-xs font-semibold text-violet-300">
          <Sparkles className="size-3.5" />
          <span>AI EDITING MODELS</span>
        </div>

        <h2 className="text-fg-0 mt-5 text-3xl font-bold tracking-tight sm:text-5xl max-w-3xl leading-[1.15]">
          AI that understands every pixel of your video
        </h2>

        <p className="text-fg-1 mt-4 text-base sm:text-lg max-w-2xl leading-relaxed">
          The most powerful AI models built for long-form to short-form transformation.
          Trained on millions of viral shorts to maximize retention and watch time.
        </p>
      </div>

      {/* 2x2 Bento Grid */}
      <div className="mt-14 grid gap-6 md:grid-cols-2">
        {/* Card 1: ClipAnything */}
        <div className="group relative overflow-hidden rounded-3xl border border-white/10 bg-[#131119] p-8 shadow-xl transition-all duration-300 hover:border-white/20 hover:bg-[#181522]">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-accent/20 px-3 py-1 text-xs font-semibold text-accent-300">
              ClipAnything™
            </span>
            <span className="text-xs font-mono text-fg-2">TRIBE fMRI Engine</span>
          </div>

          <h3 className="text-fg-0 mt-6 text-2xl font-bold tracking-tight">
            Spot the 10 most viral moments automatically
          </h3>

          <p className="text-fg-1 mt-3 text-sm leading-relaxed">
            Most clipping tools only skim for loud audio. Aksharo uses neuro-attention AI
            to detect narrative hooks, emotional climaxes, and dopamine spikes that stop the scroll.
          </p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between text-fg-2">
                <span>Podcast Episode (92 min)</span>
                <span className="text-emerald-400 font-semibold">12 Clips Extracted</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-gradient-to-r from-accent to-emerald-400 w-full rounded-full" />
              </div>
              <div className="flex items-center justify-between text-[11px] text-fg-2 pt-1">
                <span>Hook Analysis: Complete</span>
                <span>Virality Range: 88 – 98</span>
              </div>
            </div>
          </div>
        </div>

        {/* Card 2: ReframeAnything */}
        <div className="group relative overflow-hidden rounded-3xl border border-white/10 bg-[#131119] p-8 shadow-xl transition-all duration-300 hover:border-white/20 hover:bg-[#181522]">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-400">
              ReframeAnything™
            </span>
            <span className="text-xs font-mono text-fg-2">YuNet Neural Vision</span>
          </div>

          <h3 className="text-fg-0 mt-6 text-2xl font-bold tracking-tight">
            Keep speakers in frame with smart active tracking
          </h3>

          <p className="text-fg-1 mt-3 text-sm leading-relaxed">
            Turn 16:9 widescreen footage into 9:16 vertical shorts effortlessly. Neural face
            tracking keeps speakers centered and dynamically switches during multi-person dialogue.
          </p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="grid grid-cols-2 gap-3 text-center text-xs">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <ScanFace className="size-5 mx-auto mb-1 text-emerald-400" />
                <span className="text-fg-0 font-medium block">Single Speaker</span>
                <span className="text-[10px] text-fg-2">Smooth 60 FPS Pan</span>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="size-5 mx-auto mb-1 flex items-center justify-center font-bold text-emerald-400">
                  ½
                </div>
                <span className="text-fg-0 font-medium block">Dual Split-Screen</span>
                <span className="text-[10px] text-fg-2">Auto Reaction View</span>
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Hinglish & Multi-Language Transcription */}
        <div className="group relative overflow-hidden rounded-3xl border border-white/10 bg-[#131119] p-8 shadow-xl transition-all duration-300 hover:border-white/20 hover:bg-[#181522]">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-semibold text-amber-400">
              Phoneme Alignment
            </span>
            <span className="text-xs font-mono text-fg-2">Hindi · Hinglish · English</span>
          </div>

          <h3 className="text-fg-0 mt-6 text-2xl font-bold tracking-tight">
            Transcribe real conversational speech without errors
          </h3>

          <p className="text-fg-1 mt-3 text-sm leading-relaxed">
            Standard transcription tools botch Indian accents, slang, and bilingual code-switching.
            Aksharo understands colloquial English, Hindi, and Hinglish with 99.4% precision.
          </p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-4 font-mono text-xs text-fg-1">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold mb-1">
              <Languages className="size-4" />
              <span>Multi-Script Devanagari & Latin</span>
            </div>
            <p className="text-fg-2 text-[11px] font-sans">
              &ldquo;Yeh strategy actually scale hoti hai jab aap retention focus karte ho.&rdquo;
            </p>
          </div>
        </div>

        {/* Card 4: NVENC Hardware Rendering */}
        <div className="group relative overflow-hidden rounded-3xl border border-white/10 bg-[#131119] p-8 shadow-xl transition-all duration-300 hover:border-white/20 hover:bg-[#181522]">
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-blue-500/20 px-3 py-1 text-xs font-semibold text-blue-400">
              NVENC Hardware Accelerated
            </span>
            <span className="text-xs font-mono text-fg-2">1080x1920 60 FPS</span>
          </div>

          <h3 className="text-fg-0 mt-6 text-2xl font-bold tracking-tight">
            Blazing fast cloud export in seconds, not hours
          </h3>

          <p className="text-fg-1 mt-3 text-sm leading-relaxed">
            Export pristine 1080x1920 MP4 clips with burned-in karaoke captions, or export
            industry-standard SRT, VTT, and ASS subtitle files for your timeline editor.
          </p>

          <div className="mt-6 rounded-2xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-blue-400 font-medium">
                <Cpu className="size-4" />
                <span>GPU Render Speed</span>
              </span>
              <span className="text-fg-0 font-bold">10x Faster than Realtime</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-fg-2">
              <span>60s 1080p Short</span>
              <span className="text-emerald-400 font-semibold">Rendered in 6 seconds</span>
            </div>
          </div>
        </div>
      </div>

      {/* Sub-CTA */}
      <div className="mt-10 flex justify-center">
        <Button variant="secondary" size="lg" asChild>
          <Link href={AUTH_NAV.getStarted.href} className="flex items-center gap-2">
            <span>Try AI Clipping Free</span>
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </section>
  );
}


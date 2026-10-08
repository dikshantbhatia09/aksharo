"use client";

import { useState } from "react";
import { Link2, Upload, Sparkles, Flame, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@montaj/ui";
import { heroCopy, HERO_LOCALE_LABEL, type HeroLocale } from "@/content/site/hero-copy";
import { AUTH_NAV } from "@/content/site/nav";
import { cn } from "@/lib/utils";
import { LiveCaptionDemo } from "./live-caption-demo";

const PLATFORMS_SUPPORTED = [
  "YouTube",
  "Zoom",
  "Google Drive",
  "Vimeo",
  "StreamYard",
  "Loom",
  "MP4 / MOV",
] as const;

export function OpusHero(): React.JSX.Element {
  const router = useRouter();
  const [locale, setLocale] = useState<HeroLocale>("en");
  const [videoUrl, setVideoUrl] = useState("");
  const copy = heroCopy(locale);

  const handleLinkSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (videoUrl.trim()) {
      router.push(`${AUTH_NAV.getStarted.href}?url=${encodeURIComponent(videoUrl.trim())}`);
    } else {
      router.push(AUTH_NAV.getStarted.href);
    }
  };

  return (
    <section className="relative mx-auto max-w-6xl px-4 pt-8 pb-16 sm:px-6 sm:pt-12 sm:pb-20 lg:pt-16">
      {/* Background Radial Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-[500px] w-[800px] rounded-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-violet-600/15 via-pink-600/5 to-transparent blur-[120px]"
      />

      <div className="relative z-10 flex flex-col items-center text-center">
        {/* Top Controls: Locale Switcher & #1 Badge */}
        <div className="mb-6 flex flex-wrap items-center justify-center gap-3">
          {/* Segmented language switcher */}
          <div
            role="group"
            aria-label="Headline language"
            className="border-white/10 inline-flex gap-0.5 rounded-full border bg-white/5 p-0.5 backdrop-blur-md"
          >
            {(["en", "hi"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={locale === option}
                onClick={() => setLocale(option)}
                data-testid={`hero-locale-${option}`}
                className={cn(
                  "h-7 min-w-12 rounded-full px-2.5 text-xs font-semibold transition-all",
                  locale === option
                    ? "bg-white text-black shadow-sm"
                    : "text-fg-2 hover:text-fg-0",
                )}
              >
                {/* eslint-disable-next-line security/detect-object-injection */}
                {HERO_LOCALE_LABEL[option]}
              </button>
            ))}
          </div>

          {/* #1 Badge */}
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3.5 py-1 text-xs font-semibold uppercase tracking-wider text-violet-300">
            <Sparkles className="size-3.5" />
            <span data-testid="hero-kicker" lang={locale}>
              {copy.kicker}
            </span>
          </div>
        </div>

        {/* Primary H1 Headline */}
        <h1 className="text-fg-0 max-w-4xl font-extrabold tracking-tight text-4xl sm:text-6xl lg:text-7xl leading-[1.08]">
          <span
            data-testid="hero-headline"
            lang={locale}
            className="bg-gradient-to-b from-white via-neutral-100 to-neutral-400 bg-clip-text text-transparent block"
          >
            {copy.headline}
          </span>
        </h1>

        {/* Hero Subtitle */}
        <div className="mt-6 flex flex-col items-center gap-2 max-w-2xl mx-auto" lang={locale}>
          <p className="text-fg-1 text-base sm:text-lg leading-relaxed font-normal">
            {copy.subheads[0]}
          </p>
        </div>

        {/* Signature Opus-Style Video Link Input & Upload Action Bar */}
        <div className="mt-10 w-full max-w-2xl">
          <form
            onSubmit={handleLinkSubmit}
            className="flex flex-col sm:flex-row items-center gap-2 rounded-2xl sm:rounded-full border border-white/12 bg-[#17141f]/90 p-2 shadow-[0_10px_40px_rgba(0,0,0,0.6)] backdrop-blur-2xl focus-within:border-white/30 transition-all"
          >
            <div className="flex w-full items-center gap-3 px-4 py-2 sm:py-0">
              <Link2 className="size-4 shrink-0 text-neutral-400" />
              <input
                type="text"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="Drop a video link (YouTube, Zoom, Vimeo...)"
                className="w-full bg-transparent text-sm text-fg-0 placeholder:text-neutral-500 focus:outline-none"
              />
            </div>

            <div className="flex w-full sm:w-auto items-center gap-2 shrink-0">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full sm:w-auto rounded-full bg-white text-black hover:bg-neutral-200 px-6 py-2.5 font-bold text-sm shadow-[0_0_20px_rgba(255,255,255,0.2)]"
                asChild
              >
                <Link href={AUTH_NAV.getStarted.href}>Get free clips</Link>
              </Button>

              <span className="hidden sm:inline text-xs text-neutral-500 font-medium">or</span>

              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="hidden sm:flex rounded-full border-white/10 bg-white/5 hover:bg-white/10 text-white px-5 py-2.5 font-medium text-sm gap-2"
                asChild
              >
                <Link href={AUTH_NAV.getStarted.href}>
                  <Upload className="size-3.5" />
                  <span>Upload files</span>
                </Link>
              </Button>
            </div>
          </form>

          {/* Micro trust note */}
          <div className="mt-3 flex items-center justify-center gap-4 text-xs text-fg-2">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-emerald-400" />
              <span>No credit card required</span>
            </span>
            <span>·</span>
            <span>1 clean export on us</span>
            <span>·</span>
            <span>Your footage never trains AI</span>
          </div>
        </div>

        {/* Supported Platforms Strip */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <span className="text-[11px] font-medium text-fg-2 mr-1">Supported inputs:</span>
          {PLATFORMS_SUPPORTED.map((platform) => (
            <span
              key={platform}
              className="rounded-full border border-white/8 bg-white/4 px-2.5 py-0.5 text-[11px] font-medium text-fg-2"
            >
              {platform}
            </span>
          ))}
        </div>

        {/* Hero Interactive Showcase Stage */}
        <div className="relative mt-14 w-full flex justify-center">
          <div className="relative overflow-hidden rounded-3xl border border-white/12 bg-gradient-to-b from-[#181522] to-[#0e0c13] p-6 sm:p-10 shadow-[0_20px_80px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
            {/* Ambient inner glow */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-accent/10 blur-[80px]"
            />

            {/* Stage Header Info Tags */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-4">
              {/* Virality score badge */}
              <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-950/40 px-3 py-1 text-xs font-semibold text-emerald-400">
                <Flame className="size-3.5 text-amber-400" />
                <span>VIRALITY SCORE: 97</span>
                <span className="text-[11px] text-emerald-300 font-normal">
                  (Hook 96% · Flow 94%)
                </span>
              </div>

              {/* Active Speaker Status */}
              <div className="flex items-center gap-2 text-xs text-fg-2 font-mono">
                <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>YuNet AI Face Tracking: ACTIVE</span>
              </div>
            </div>

            {/* CanvasKit Live Caption Demo */}
            <div className="flex justify-center">
              <LiveCaptionDemo />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}


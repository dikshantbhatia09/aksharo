"use client";

import { useState } from "react";
import { Link2, Sparkles, ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@montaj/ui";
import { AUTH_NAV } from "@/content/site/nav";

export function CtaBanner(): React.JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState("");

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (url.trim()) {
      router.push(`${AUTH_NAV.getStarted.href}?url=${encodeURIComponent(url.trim())}`);
    } else {
      router.push(AUTH_NAV.getStarted.href);
    }
  };

  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Glowing Container */}
      <div className="relative overflow-hidden rounded-3xl border border-white/15 bg-gradient-to-b from-[#1c1828] via-[#14121c] to-[#0e0c14] p-8 sm:p-16 text-center shadow-[0_0_80px_rgba(147,51,234,0.18)]">
        {/* Ambient Top Glow */}
        <div
          aria-hidden="true"
          className="absolute -top-32 left-1/2 -translate-x-1/2 h-64 w-[600px] rounded-full bg-accent/20 blur-[100px] pointer-events-none"
        />

        <div className="relative z-10 flex flex-col items-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/15 px-3.5 py-1 text-xs font-semibold text-accent-200">
            <Sparkles className="size-3.5" />
            <span>START FOR FREE TODAY</span>
          </div>

          <h2 className="text-fg-0 mt-6 text-3xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl max-w-3xl leading-[1.1]">
            Ready to turn your long videos into viral clips?
          </h2>

          <p className="text-fg-1 mt-4 max-w-xl text-base sm:text-lg leading-relaxed">
            Join 50,000+ creators creating 10x faster with Aksharo. One clean export on us — no credit card
            required.
          </p>

          {/* Video URL Input & Start Free Action */}
          <form
            onSubmit={handleSubmit}
            className="mt-10 flex w-full max-w-xl flex-col sm:flex-row items-center gap-2 rounded-full border border-white/15 bg-[#171420]/90 p-1.5 shadow-2xl backdrop-blur-xl focus-within:border-white/30 transition-all"
          >
            <div className="flex w-full items-center gap-3 px-4 py-2 sm:py-0">
              <Link2 className="size-4 shrink-0 text-fg-2" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Drop a video link (YouTube, Zoom, Vimeo...)"
                className="w-full bg-transparent text-sm text-fg-0 placeholder:text-fg-2 focus:outline-none"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full sm:w-auto shrink-0 rounded-full px-7 font-bold shadow-lg"
              asChild
            >
              <Link href={AUTH_NAV.getStarted.href}>Start free</Link>
            </Button>
          </form>

          {/* Trust Guarantees */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-6 text-xs text-fg-2">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-4 text-emerald-400" />
              <span>No credit card required</span>
            </span>
            <span>·</span>
            <span>1 clean export on us</span>
            <span>·</span>
            <span>Your footage never trains AI</span>
          </div>
        </div>
      </div>
    </section>
  );
}


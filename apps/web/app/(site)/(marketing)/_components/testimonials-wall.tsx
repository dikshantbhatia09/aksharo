"use client";

import Image from "next/image";
import { Star } from "lucide-react";

interface Testimonial {
  readonly quote: string;
  readonly author: string;
  readonly role: string;
  readonly followers: string;
  readonly avatar: string;
}

const TESTIMONIALS: readonly Testimonial[] = [
  {
    quote:
      "Aksharo has been crucial in helping us 10x our short-form output. We test what hooks stick rather than wasting hours scrubbing timelines. It’s a complete no-brainer for any creator.",
    author: "Kabir Mehta",
    role: "Host, The Bharat Tech Podcast",
    followers: "1.2M Subscribers",
    avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=120&h=120&fit=crop&crop=faces",
  },
  {
    quote:
      "The only AI tool that genuinely nails Indian accents and colloquial Hinglish speech. The phoneme alignment is spot-on and the animated styles look straight out of a professional editing suite.",
    author: "Ananya Deshmukh",
    role: "Digital Media Strategist",
    followers: "850K Followers",
    avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop&crop=faces",
  },
  {
    quote:
      "The Virality Score actually works. The clips it flagged above 90 routinely cross 500k views on YouTube Shorts and Reels. It knows what will stop the scroll before we even publish.",
    author: "Rohan Varma",
    role: "Founder, GrowthMedia Agency",
    followers: "15+ Client Channels",
    avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=120&h=120&fit=crop&crop=faces",
  },
  {
    quote:
      "It used to take our editing team 3 days to turn a 90-minute interview into 10 shorts. With Aksharo, our first batch is ready in 4 minutes flat with active speaker tracking.",
    author: "Sneha Nair",
    role: "Content Lead, Pulse Studios",
    followers: "3.4M Network Reach",
    avatar: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=120&h=120&fit=crop&crop=faces",
  },
];

export function TestimonialsWall(): React.JSX.Element {
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-24">
      {/* Section Header */}
      <div className="flex flex-col items-center text-center">
        <p className="text-fg-2 text-xs font-semibold uppercase tracking-wider">
          Creator Stories & Wall of Love
        </p>

        <h2 className="text-fg-0 mt-4 text-3xl font-bold tracking-tight sm:text-5xl max-w-3xl leading-[1.15]">
          Loved by top podcasters & creators worldwide
        </h2>

        <p className="text-fg-1 mt-4 text-base sm:text-lg max-w-2xl leading-relaxed">
          See why creators and agencies rely on Aksharo to turn long-form recordings into viral social
          content every single day.
        </p>
      </div>

      {/* Grid of Testimonials */}
      <div className="mt-14 grid gap-6 sm:grid-cols-2">
        {TESTIMONIALS.map((t) => (
          <div
            key={t.author}
            className="flex flex-col justify-between rounded-3xl border border-white/10 bg-[#14121a]/90 p-8 shadow-lg backdrop-blur-xl transition-all duration-300 hover:border-white/20 hover:bg-[#1a1723]"
          >
            <div>
              <div className="flex items-center gap-1 text-amber-400">
                {Array.from({ length: 5 }).map((_, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <Star key={i} className="size-4 fill-amber-400" />
                ))}
              </div>

              <blockquote className="text-fg-0 mt-5 text-sm sm:text-base leading-relaxed font-normal">
                &ldquo;{t.quote}&rdquo;
              </blockquote>
            </div>

            <div className="mt-8 flex items-center gap-3.5 border-t border-white/8 pt-6">
              <div className="relative size-11 shrink-0 overflow-hidden rounded-full ring-2 ring-white/10">
                <Image
                  src={t.avatar}
                  alt={t.author}
                  width={44}
                  height={44}
                  className="size-full object-cover"
                  unoptimized
                />
              </div>
              <div className="flex flex-col">
                <span className="text-fg-0 text-sm font-semibold">{t.author}</span>
                <span className="text-fg-2 text-xs">{t.role}</span>
                <span className="text-accent-300 text-[11px] font-medium mt-0.5">{t.followers}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}


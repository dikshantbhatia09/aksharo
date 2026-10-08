"use client";

import Image from "next/image";

interface CreatorStat {
  readonly name: string;
  readonly handle: string;
  readonly followers: string;
  readonly role: string;
  readonly avatar: string;
}

const CREATORS: readonly CreatorStat[] = [
  {
    name: "Ranveer Allahbadia",
    handle: "@beerbiceps",
    followers: "9.8M",
    role: "The Ranveer Show",
    avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces",
  },
  {
    name: "Raj Shamani",
    handle: "@rajshamani",
    followers: "5.3M",
    role: "Figuring Out Podcast",
    avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces",
  },
  {
    name: "Prakhar Gupta",
    handle: "@prakharkepravachan",
    followers: "1.5M",
    role: "Culture & Philosophy",
    avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&crop=faces",
  },
  {
    name: "Ali Abdaal",
    handle: "@aliabdaal",
    followers: "5.8M",
    role: "Productivity & Tech",
    avatar: "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=100&h=100&fit=crop&crop=faces",
  },
  {
    name: "Mark Rober",
    handle: "@markrober",
    followers: "65M",
    role: "Science & Engineering",
    avatar: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=100&h=100&fit=crop&crop=faces",
  },
  {
    name: "Flagrant",
    handle: "@theflagrantpod",
    followers: "1.8M",
    role: "Comedy & Culture",
    avatar: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&h=100&fit=crop&crop=faces",
  },
];

function YoutubeIcon(): React.JSX.Element {
  return (
    <svg className="size-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

function InstagramIcon(): React.JSX.Element {
  return (
    <svg className="size-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  );
}

function TikTokIcon(): React.JSX.Element {
  return (
    <svg className="size-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.24 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
    </svg>
  );
}

const PLATFORMS = [
  { name: "YouTube Shorts", renderIcon: YoutubeIcon },
  { name: "Instagram Reels", renderIcon: InstagramIcon },
  { name: "TikTok", renderIcon: TikTokIcon },
] as const;

export function SocialProofBar(): React.JSX.Element {
  return (
    <section className="relative mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="flex flex-col items-center text-center">
        <p className="text-fg-2 text-xs font-semibold tracking-wider uppercase">
          Trusted by 50,000+ top creators, podcasters & media agencies
        </p>

        {/* Creator Avatar Chips Bar */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 sm:gap-4">
          {CREATORS.map((creator) => (
            <div
              key={creator.handle}
              className="group flex items-center gap-2.5 rounded-full border border-white/8 bg-[#18161d]/80 px-3 py-1.5 backdrop-blur-md transition-all duration-200 hover:border-white/20 hover:bg-[#201d27]"
            >
              <div className="relative size-7 shrink-0 overflow-hidden rounded-full ring-1 ring-white/10">
                <Image
                  src={creator.avatar}
                  alt={creator.name}
                  width={28}
                  height={28}
                  className="size-full object-cover"
                  unoptimized
                />
              </div>
              <div className="flex flex-col text-left">
                <div className="flex items-center gap-1.5">
                  <span className="text-fg-0 text-xs font-medium leading-none">{creator.name}</span>
                  <span className="rounded-full bg-accent/20 px-1.5 py-0.2 text-[10px] font-semibold text-accent-300">
                    {creator.followers}
                  </span>
                </div>
                <span className="text-fg-2 text-[10px] leading-tight">{creator.role}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Platform Integration Logos */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-6 sm:gap-10 opacity-70 transition-opacity hover:opacity-100">
          {PLATFORMS.map((platform) => {
            const Icon = platform.renderIcon;
            return (
              <div
                key={platform.name}
                className="flex items-center gap-2 text-fg-2 transition-colors hover:text-fg-0"
              >
                <Icon />
                <span className="text-xs font-medium tracking-wide">{platform.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}


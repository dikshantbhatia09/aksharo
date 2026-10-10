"use client";

/**
 * Platform-Tailored Social Copywriting Engine UI (Pillar 7 §02).
 *
 * Provides dedicated, culturally-native post packs for 5 platforms:
 *   - YouTube Shorts (< 70 chars keyword-dense title with #Shorts)
 *   - Instagram Reels (< 125 chars pre-fold hook + bullet takeaways + Save CTA)
 *   - TikTok (ultra-casual curiosity one-liner + viral community tags)
 *   - LinkedIn Video (professional problem -> framework -> question)
 *   - X / Twitter (< 280 chars contrarian hook tweet for debate)
 *
 * Each tab displays platform brand icons, strict character/hashtag limits,
 * and 1-click "Copy to Clipboard" buttons with instant toast confirmations.
 */
import { Check, Copy, Sparkles } from "lucide-react";
import * as React from "react";

import type { PlatformSocialPack, RepurposeClipCopy } from "@montaj/api-client";
import { buildPlatformSocialPack } from "@montaj/repurpose-contracts";
import { Badge, Button, cn, toast } from "@montaj/ui";

import { copyText } from "@/components/repurpose/copy-text";

export type SocialPlatformId = "youtube" | "instagram" | "tiktok" | "linkedin" | "x";

// ---------------------------------------------------------------------------
// Official Platform Brand SVGs
// ---------------------------------------------------------------------------

export function YouTubeIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4 text-[#FF0000]", className)}
      aria-hidden="true"
    >
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

export function InstagramIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4 text-[#E4405F]", className)}
      aria-hidden="true"
    >
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  );
}

export function TikTokIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4 text-[#00f2fe]", className)}
      aria-hidden="true"
    >
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.298-.002.596.042.88.13V9.4a6.33 6.33 0 0 0-1-.08A6.34 6.34 0 0 0 3 15.66a6.34 6.34 0 0 0 10.82 4.46V12.1a8.16 8.16 0 0 0 5.77 2.33v-3.49a4.85 4.85 0 0 1-3.77-1.92v-.01z" />
    </svg>
  );
}

export function LinkedInIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4 text-[#0A66C2]", className)}
      aria-hidden="true"
    >
      <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
    </svg>
  );
}

export function XIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4 text-fg-0", className)}
      aria-hidden="true"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export interface PlatformConfig {
  readonly id: SocialPlatformId;
  readonly name: string;
  readonly badgeLabel: string;
  readonly limitNotice?: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
}

export const SOCIAL_PLATFORMS: readonly PlatformConfig[] = [
  {
    id: "youtube",
    name: "YouTube Shorts",
    badgeLabel: "< 70 chars title",
    limitNotice: "Title must be < 70 chars with #Shorts for search discovery",
    icon: YouTubeIcon,
  },
  {
    id: "instagram",
    name: "Instagram Reels",
    badgeLabel: "Pre-fold hook",
    limitNotice: "Opens with punchy hook before 125-char '...more' fold",
    icon: InstagramIcon,
  },
  {
    id: "tiktok",
    name: "TikTok",
    badgeLabel: "Curiosity one-liner",
    limitNotice: "Ultra-casual one-liner with viral community tags",
    icon: TikTokIcon,
  },
  {
    id: "linkedin",
    name: "LinkedIn Video",
    badgeLabel: "Thought leadership",
    limitNotice: "Strategic breakdown: Problem -> Framework -> Question",
    icon: LinkedInIcon,
  },
  {
    id: "x",
    name: "X (Twitter)",
    badgeLabel: "< 280 chars",
    limitNotice: "Contrarian hook tweet engineered for debate and reposts",
    icon: XIcon,
  },
];

export interface SocialCopyTabsProps {
  readonly copy?: RepurposeClipCopy | null;
  readonly socialPack?: PlatformSocialPack | null;
  readonly title?: string;
  readonly className?: string;
}

export function SocialCopyTabs({
  copy,
  socialPack: directPack,
  title = "Clip",
  className,
}: SocialCopyTabsProps): React.JSX.Element | null {
  const [activePlatform, setActivePlatform] = React.useState<SocialPlatformId>("youtube");
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);

  // Derive PlatformSocialPack either from directPack or from copy via contract helper
  const resolvedPack: PlatformSocialPack | null = React.useMemo(() => {
    if (directPack) return directPack;
    if (copy?.socialPack) return copy.socialPack;
    if (copy) {
      return buildPlatformSocialPack({
        title: copy.title ?? title,
        hook: copy.hook,
        summary: copy.summary,
        description: copy.description,
        cta: copy.cta,
        hashtags: copy.hashtags,
        platforms: copy.platforms,
      });
    }
    return null;
  }, [directPack, copy, title]);

  if (!resolvedPack) {
    return null;
  }

  const handleCopy = async (text: string, label: string, key: string): Promise<void> => {
    const success = await copyText(text);
    if (success) {
      setCopiedKey(key);
      toast.success(`Copied ${label} to clipboard`);
      setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 2000);
    } else {
      toast.error(`Could not copy ${label}`);
    }
  };

  const handleCopyFullActive = async (): Promise<void> => {
    let fullText = "";
    let label = "";

    switch (activePlatform) {
      case "youtube":
        fullText = `${resolvedPack.youtube.title}\n\n${resolvedPack.youtube.description}\n\n${resolvedPack.youtube.tags.map((t) => `#${t}`).join(" ")}`;
        label = "YouTube Shorts pack";
        break;
      case "instagram":
        fullText = `${resolvedPack.instagram.caption}\n\n${resolvedPack.instagram.callToAction}\n\n${resolvedPack.instagram.hashtags.join(" ")}`;
        label = "Instagram Reels caption";
        break;
      case "tiktok":
        fullText = `${resolvedPack.tiktok.caption}\n\n${resolvedPack.tiktok.hashtags.join(" ")}`;
        label = "TikTok caption";
        break;
      case "linkedin":
        fullText = `${resolvedPack.linkedin.postText}\n\n${resolvedPack.linkedin.hashtags.join(" ")}`;
        label = "LinkedIn post";
        break;
      case "x":
        fullText = resolvedPack.twitter.tweetText;
        label = "X tweet";
        break;
    }

    await handleCopy(fullText.trim(), label, `full-${activePlatform}`);
  };

  return (
    <div
      className={cn("flex flex-col gap-3 rounded-md border border-border bg-surface p-3.5", className)}
      data-testid="social-copy-tabs"
    >
      {/* Header with Title and 1-Click Copy Active Platform Pack */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent-300" strokeWidth={2} aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-wider text-fg-0">
            Platform-Tailored Copy Pack
          </span>
          <Badge tone="accent" className="px-1.5 py-0 text-3xs font-semibold">
            5 Platforms
          </Badge>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs font-medium"
          onClick={() => void handleCopyFullActive()}
          data-testid="copy-active-platform-btn"
        >
          {copiedKey === `full-${activePlatform}` ? (
            <Check className="size-3.5 text-accent-300" strokeWidth={2} aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          )}
          <span>
            {copiedKey === `full-${activePlatform}`
              ? "Copied!"
              : `Copy ${SOCIAL_PLATFORMS.find((p) => p.id === activePlatform)?.name} Post`}
          </span>
        </Button>
      </div>

      {/* Tab Selector Buttons with Official Brand Icons */}
      <div
        role="tablist"
        aria-label="Social media destination platforms"
        className="flex flex-wrap items-center gap-1.5 rounded-sm bg-bg-1 p-1"
        data-testid="platform-tablist"
      >
        {SOCIAL_PLATFORMS.map((platform) => {
          const Icon = platform.icon;
          const isActive = activePlatform === platform.id;
          return (
            <button
              key={platform.id}
              role="tab"
              type="button"
              id={`tab-${platform.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${platform.id}`}
              onClick={() => setActivePlatform(platform.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-surface text-fg-0 shadow-xs ring-1 ring-border"
                  : "text-fg-2 hover:bg-surface/50 hover:text-fg-1",
              )}
              data-testid={`tab-${platform.id}`}
            >
              <Icon />
              <span>{platform.name}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      <div className="mt-1">
        {activePlatform === "youtube" && (
          <div
            id="panel-youtube"
            role="tabpanel"
            aria-labelledby="tab-youtube"
            className="flex flex-col gap-3"
            data-testid="platform-panel-youtube"
          >
            {/* Title Section */}
            <div className="flex flex-col gap-1 rounded-sm border border-border/60 bg-bg-0 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                    YouTube Shorts Title
                  </span>
                  <Badge
                    tone={resolvedPack.youtube.title.length <= 70 ? "accepted" : "warning"}
                    className="px-1.5 py-0 text-3xs font-mono"
                    data-testid="yt-title-limit-badge"
                  >
                    {resolvedPack.youtube.title.length}/70 chars
                  </Badge>
                  {resolvedPack.youtube.title.toLowerCase().includes("#shorts") ? (
                    <Badge tone="neutral" className="px-1 py-0 text-3xs">
                      #Shorts ✓
                    </Badge>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-2xs"
                  onClick={() =>
                    void handleCopy(resolvedPack.youtube.title, "YouTube title", "yt-title")
                  }
                  data-testid="copy-yt-title"
                >
                  {copiedKey === "yt-title" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                  <span>{copiedKey === "yt-title" ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <p className="m-0 text-xs font-medium leading-snug text-fg-0">
                {resolvedPack.youtube.title}
              </p>
            </div>

            {/* Description Section */}
            <div className="flex flex-col gap-1 rounded-sm border border-border/60 bg-bg-0 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                  Description
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-2xs"
                  onClick={() =>
                    void handleCopy(
                      resolvedPack.youtube.description,
                      "YouTube description",
                      "yt-desc",
                    )
                  }
                  data-testid="copy-yt-desc"
                >
                  {copiedKey === "yt-desc" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                  <span>{copiedKey === "yt-desc" ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <p className="m-0 whitespace-pre-line text-xs leading-relaxed text-fg-1">
                {resolvedPack.youtube.description || "No description generated."}
              </p>
            </div>

            {/* Tags Section */}
            {resolvedPack.youtube.tags.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-sm border border-border/60 bg-bg-0 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                    Tags ({resolvedPack.youtube.tags.length})
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-2xs"
                    onClick={() =>
                      void handleCopy(
                        resolvedPack.youtube.tags.join(", "),
                        "YouTube tags",
                        "yt-tags",
                      )
                    }
                    data-testid="copy-yt-tags"
                  >
                    {copiedKey === "yt-tags" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                    <span>{copiedKey === "yt-tags" ? "Copied" : "Copy"}</span>
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {resolvedPack.youtube.tags.map((tag) => (
                    <Badge key={tag} tone="neutral" className="text-3xs">
                      #{tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activePlatform === "instagram" && (
          <div
            id="panel-instagram"
            role="tabpanel"
            aria-labelledby="tab-instagram"
            className="flex flex-col gap-3"
            data-testid="platform-panel-instagram"
          >
            {/* Caption Body */}
            <div className="flex flex-col gap-1 rounded-sm border border-border/60 bg-bg-0 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                    Instagram Reel Caption
                  </span>
                  <Badge tone="neutral" className="px-1.5 py-0 text-3xs font-mono">
                    {resolvedPack.instagram.caption.length}/2,200 chars
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-2xs"
                  onClick={() =>
                    void handleCopy(
                      `${resolvedPack.instagram.caption}\n\n${resolvedPack.instagram.callToAction}`,
                      "Instagram caption",
                      "ig-caption",
                    )
                  }
                  data-testid="copy-ig-caption"
                >
                  {copiedKey === "ig-caption" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                  <span>{copiedKey === "ig-caption" ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <p className="m-0 whitespace-pre-line text-xs leading-relaxed text-fg-0">
                {resolvedPack.instagram.caption}
              </p>
              {resolvedPack.instagram.callToAction && (
                <div className="mt-2 rounded-xs border-l-2 border-accent-400 bg-accent/5 px-2 py-1 text-2xs font-medium text-accent-200">
                  📌 Call to Action: {resolvedPack.instagram.callToAction}
                </div>
              )}
            </div>

            {/* Hashtags */}
            {resolvedPack.instagram.hashtags.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-sm border border-border/60 bg-bg-0 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                    Reel Hashtags ({resolvedPack.instagram.hashtags.length})
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-2xs"
                    onClick={() =>
                      void handleCopy(
                        resolvedPack.instagram.hashtags.join(" "),
                        "Instagram hashtags",
                        "ig-tags",
                      )
                    }
                    data-testid="copy-ig-tags"
                  >
                    {copiedKey === "ig-tags" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                    <span>{copiedKey === "ig-tags" ? "Copied" : "Copy"}</span>
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {resolvedPack.instagram.hashtags.map((tag) => (
                    <Badge key={tag} tone="neutral" className="text-3xs">
                      {tag.startsWith("#") ? tag : `#${tag}`}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activePlatform === "tiktok" && (
          <div
            id="panel-tiktok"
            role="tabpanel"
            aria-labelledby="tab-tiktok"
            className="flex flex-col gap-3"
            data-testid="platform-panel-tiktok"
          >
            <div className="flex flex-col gap-1 rounded-sm border border-border/60 bg-bg-0 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                    TikTok Curiosity One-Liner
                  </span>
                  <Badge tone="neutral" className="px-1.5 py-0 text-3xs font-mono">
                    {resolvedPack.tiktok.caption.length} chars
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-2xs"
                  onClick={() =>
                    void handleCopy(
                      `${resolvedPack.tiktok.caption} ${resolvedPack.tiktok.hashtags.join(" ")}`.trim(),
                      "TikTok caption",
                      "tt-caption",
                    )
                  }
                  data-testid="copy-tt-caption"
                >
                  {copiedKey === "tt-caption" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                  <span>{copiedKey === "tt-caption" ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <p className="m-0 text-xs font-medium leading-relaxed text-fg-0">
                {resolvedPack.tiktok.caption}
              </p>
              {resolvedPack.tiktok.hashtags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {resolvedPack.tiktok.hashtags.map((tag) => (
                    <Badge key={tag} tone="neutral" className="text-3xs">
                      {tag.startsWith("#") ? tag : `#${tag}`}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activePlatform === "linkedin" && (
          <div
            id="panel-linkedin"
            role="tabpanel"
            aria-labelledby="tab-linkedin"
            className="flex flex-col gap-3"
            data-testid="platform-panel-linkedin"
          >
            <div className="flex flex-col gap-1 rounded-sm border border-border/60 bg-bg-0 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                    LinkedIn Thought-Leadership Post
                  </span>
                  <Badge tone="neutral" className="px-1.5 py-0 text-3xs font-mono">
                    {resolvedPack.linkedin.postText.length}/3,000 chars
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-2xs"
                  onClick={() =>
                    void handleCopy(
                      `${resolvedPack.linkedin.postText}\n\n${resolvedPack.linkedin.hashtags.join(" ")}`.trim(),
                      "LinkedIn post",
                      "li-post",
                    )
                  }
                  data-testid="copy-li-post"
                >
                  {copiedKey === "li-post" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                  <span>{copiedKey === "li-post" ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <p className="m-0 whitespace-pre-line text-xs leading-relaxed text-fg-0">
                {resolvedPack.linkedin.postText}
              </p>
              {resolvedPack.linkedin.hashtags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {resolvedPack.linkedin.hashtags.map((tag) => (
                    <Badge key={tag} tone="neutral" className="text-3xs">
                      {tag.startsWith("#") ? tag : `#${tag}`}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activePlatform === "x" && (
          <div
            id="panel-x"
            role="tabpanel"
            aria-labelledby="tab-x"
            className="flex flex-col gap-3"
            data-testid="platform-panel-x"
          >
            <div className="flex flex-col gap-1 rounded-sm border border-border/60 bg-bg-0 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-wider text-fg-2">
                    X Hook Tweet
                  </span>
                  <Badge
                    tone={resolvedPack.twitter.tweetText.length <= 280 ? "accepted" : "warning"}
                    className="px-1.5 py-0 text-3xs font-mono"
                    data-testid="x-tweet-limit-badge"
                  >
                    {resolvedPack.twitter.tweetText.length}/280 chars
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-2xs"
                  onClick={() =>
                    void handleCopy(
                      resolvedPack.twitter.tweetText,
                      "X tweet",
                      "x-tweet",
                    )
                  }
                  data-testid="copy-x-tweet"
                >
                  {copiedKey === "x-tweet" ? <Check className="size-3 text-accent-300" /> : <Copy className="size-3" />}
                  <span>{copiedKey === "x-tweet" ? "Copied" : "Copy"}</span>
                </Button>
              </div>
              <p className="m-0 text-xs font-medium leading-relaxed text-fg-0">
                {resolvedPack.twitter.tweetText}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

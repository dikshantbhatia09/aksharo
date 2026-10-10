"use client";

/**
 * Trend-Aware Hashtag Recommendation Engine UI (Pillar 7 §03).
 *
 * Provides creators with:
 *   - 3-Tier Pyramid visualization (Broad Category 10M+, Community Niche 100k-1M, Hyper-Specific <100k)
 *   - Interactive pills with 1-click removal and custom tag addition
 *   - Platform-specific limits and quota indicators (YouTube Shorts, Instagram, TikTok, LinkedIn, X)
 *   - 1-Click "Copy Hashtag Bundle" with clipboard feedback and toast notifications
 *   - Auto-Balance button to regenerate mathematically optimal bundles
 */

import { Check, Copy, Plus, RefreshCw, X } from "lucide-react";
import * as React from "react";

import {
  classifyTagTier,
  PLATFORM_HASHTAG_RULES,
  recommendPyramidBundle,
  sanitizeHashtag,
  type DestinationPlatform,
  type HashtagTier,
} from "@montaj/shared";
import { Badge, Button, cn, toast } from "@montaj/ui";

import { copyText } from "@/components/repurpose/copy-text";

export interface HashtagPickerProps {
  readonly initialTags?: readonly string[];
  readonly platform?: DestinationPlatform;
  readonly text?: string;
  readonly title?: string;
  readonly onChange?: (tags: string[]) => void;
  readonly className?: string;
}

export function HashtagPicker({
  initialTags = [],
  platform = "youtube",
  text = "",
  title = "",
  onChange,
  className,
}: HashtagPickerProps): React.JSX.Element {
  const [selectedPlatform, setSelectedPlatform] = React.useState<DestinationPlatform>(platform);
  const [tags, setTags] = React.useState<string[]>(() => {
    if (initialTags.length > 0) {
      return [...initialTags];
    }
    const initialBundle = recommendPyramidBundle({
      text: text || title || "Shorts video clip",
      title,
      platform,
    });
    return [...initialBundle.all];
  });
  const [inputValue, setInputValue] = React.useState("");
  const [copied, setCopied] = React.useState(false);

  // Sync when initialTags or platform changes from parent
  React.useEffect(() => {
    if (initialTags.length > 0) {
      setTags([...initialTags]);
    }
  }, [initialTags]);

  React.useEffect(() => {
    setSelectedPlatform(platform);
  }, [platform]);

  const platformRule = PLATFORM_HASHTAG_RULES[selectedPlatform] ?? PLATFORM_HASHTAG_RULES.default;

  // Group current tags into 3 tiers
  const tieredTags = React.useMemo(() => {
    const broad: string[] = [];
    const community: string[] = [];
    const niche: string[] = [];

    for (const tag of tags) {
      const tier = classifyTagTier(tag);
      if (tier === "BROAD") broad.push(tag);
      else if (tier === "COMMUNITY") community.push(tag);
      else niche.push(tag);
    }

    return { broad, community, niche };
  }, [tags]);

  const updateTags = (newTags: string[]): void => {
    setTags(newTags);
    onChange?.(newTags);
  };

  const handleRemoveTag = (tagToRemove: string): void => {
    const next = tags.filter((t) => t.toLowerCase() !== tagToRemove.toLowerCase());
    updateTags(next);
  };

  const handleAddCustomTag = (e?: React.FormEvent): void => {
    if (e) e.preventDefault();
    const clean = sanitizeHashtag(inputValue);
    if (!clean) {
      toast.error("Please enter a valid hashtag (alphanumeric, no spaces).");
      return;
    }
    if (tags.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      toast.error(`Hashtag ${clean} is already in the bundle.`);
      return;
    }
    if (tags.length >= platformRule.maxTags) {
      toast.warning(
        `Exceeding ${platformRule.platform} limit (${tags.length}/${platformRule.maxTags}). Tag added, but consider trimming.`,
      );
    }

    const next = [...tags, clean];
    updateTags(next);
    setInputValue("");
  };

  const handleAutoBalance = (): void => {
    const bundle = recommendPyramidBundle({
      text: text || title || tags.join(" "),
      title,
      platform: selectedPlatform,
    });
    updateTags([...bundle.all]);
    toast.success(`Balanced 3-tier pyramid for ${platformRule.platform}`);
  };

  const handleCopyBundle = async (): Promise<void> => {
    if (tags.length === 0) {
      toast.error("No hashtags to copy.");
      return;
    }
    const formatted = tags.join(" ");
    const success = await copyText(formatted);
    if (success) {
      setCopied(true);
      toast.success(`Copied ${tags.length} hashtags to clipboard`);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error("Could not copy hashtags to clipboard.");
    }
  };

  const getTierBadgeProps = (tier: HashtagTier) => {
    switch (tier) {
      case "BROAD":
        return { label: "Tier 1 • Broad (10M+)", tone: "neutral" as const, dotColor: "bg-blue-400" };
      case "COMMUNITY":
        return { label: "Tier 2 • Community (100k-1M)", tone: "accent" as const, dotColor: "bg-emerald-400" };
      case "NICHE":
        return { label: "Tier 3 • Niche (<100k)", tone: "warning" as const, dotColor: "bg-purple-400" };
    }
  };

  const isOverLimit = tags.length > platformRule.maxTags;

  return (
    <div
      className={cn("flex flex-col gap-3 rounded-md border border-border bg-surface p-3.5", className)}
      data-testid="hashtag-picker"
    >
      {/* Header with Title, Counts, and 1-Click Copy */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-fg-0">
            Pyramid Hashtag Bundle
          </span>
          <Badge
            tone={isOverLimit ? "warning" : "neutral"}
            className="px-1.5 py-0 text-3xs font-mono font-medium"
            data-testid="hashtag-count-badge"
          >
            {tags.length}/{platformRule.maxTags} tags
          </Badge>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-2xs"
            onClick={handleAutoBalance}
            title="Auto-balance 3-tier pyramid ratio"
            data-testid="autobalance-btn"
          >
            <RefreshCw className="size-3 text-fg-2" />
            <span className="hidden sm:inline">Auto-Balance</span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs font-medium"
            onClick={() => void handleCopyBundle()}
            data-testid="copy-hashtag-bundle-btn"
          >
            {copied ? (
              <Check className="size-3.5 text-accent-300" strokeWidth={2} />
            ) : (
              <Copy className="size-3.5" strokeWidth={1.75} />
            )}
            <span>{copied ? "Copied Bundle!" : "Copy Hashtag Bundle"}</span>
          </Button>
        </div>
      </div>

      {/* 3-Tier Distribution Summary Bar */}
      <div
        className="grid grid-cols-3 gap-2 rounded-sm border border-border/60 bg-bg-1 p-2 text-3xs"
        data-testid="pyramid-tier-summary"
      >
        <div className="flex flex-col items-center justify-center gap-0.5 border-r border-border/50 text-center">
          <span className="font-semibold text-blue-400">Tier 1: Broad</span>
          <span className="text-fg-2">{tieredTags.broad.length} tags (10M+)</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-0.5 border-r border-border/50 text-center">
          <span className="font-semibold text-emerald-400">Tier 2: Community</span>
          <span className="text-fg-2">{tieredTags.community.length} tags (100k-1M)</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-0.5 text-center">
          <span className="font-semibold text-purple-400">Tier 3: Hyper-Niche</span>
          <span className="text-fg-2">{tieredTags.niche.length} tags (&lt;100k)</span>
        </div>
      </div>

      {/* Interactive Tag Pills */}
      <div className="flex flex-wrap gap-1.5 min-h-[40px] items-center" data-testid="hashtag-pills-list">
        {tags.length === 0 ? (
          <p className="m-0 text-xs italic text-fg-2">No hashtags in bundle. Click Auto-Balance or add custom tags below.</p>
        ) : (
          tags.map((tag) => {
            const tier = classifyTagTier(tag);
            const tierMeta = getTierBadgeProps(tier);
            return (
              <span
                key={tag}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-bg-0 py-1 pl-2.5 pr-1.5 text-xs font-medium text-fg-0 transition-colors shadow-2xs hover:border-border",
                )}
                data-testid={`hashtag-pill-${tag.replace(/^#/, "")}`}
              >
                <span className={cn("size-1.5 rounded-full", tierMeta.dotColor)} aria-hidden="true" />
                <span>{tag.startsWith("#") ? tag : `#${tag}`}</span>
                <button
                  type="button"
                  aria-label={`Remove hashtag ${tag}`}
                  onClick={() => handleRemoveTag(tag)}
                  className="rounded-full p-0.5 text-fg-2 hover:bg-surface hover:text-fg-0 transition-colors"
                  data-testid={`remove-tag-btn-${tag.replace(/^#/, "")}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })
        )}
      </div>

      {/* Add Custom Tag Form */}
      <form onSubmit={handleAddCustomTag} className="flex items-center gap-2 pt-1 border-t border-border/60">
        <div className="relative flex-1">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Add custom hashtag (e.g. #ragpipeline)..."
            className="w-full rounded-sm border border-border bg-bg-0 px-2.5 py-1 text-xs text-fg-0 placeholder:text-fg-2 focus:border-accent-300 focus:outline-none"
            data-testid="custom-tag-input"
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="h-7 px-2.5 text-xs font-medium"
          disabled={!inputValue.trim()}
          data-testid="add-tag-btn"
        >
          <Plus className="size-3.5" />
          <span>Add</span>
        </Button>
      </form>
    </div>
  );
}

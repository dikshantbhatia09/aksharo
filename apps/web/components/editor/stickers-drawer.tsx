"use client";

import {
  Check,
  Clock,
  Flame,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Smile,
  X,
  Zap,
} from "lucide-react";
import * as React from "react";

import { Badge, Button, cn } from "@montaj/ui";

import {
  useCacheStickerAsset,
  useStickerRecommend,
  useStickersCategories,
  useStickersSearch,
  useStickersTrending,
  type StickerAssetItem,
  type StickerContentType,
  type StickerProvider,
} from "./stickers/use-stickers-library";

export interface StickersDrawerProps {
  readonly projectId?: string;
  readonly transcriptText?: string;
  readonly onInsertSticker?: (sticker: StickerAssetItem, cachedUrl?: string) => void;
  readonly onClose?: () => void;
  readonly className?: string;
  readonly initialQuery?: string;
}

export function StickersDrawer({
  projectId,
  transcriptText = "",
  onInsertSticker,
  onClose,
  className,
  initialQuery = "",
}: StickersDrawerProps): React.JSX.Element {
  const [searchInput, setSearchInput] = React.useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = React.useState(initialQuery);
  const [selectedCategory, setSelectedCategory] = React.useState("All");
  const [selectedType, setSelectedType] = React.useState<StickerContentType>("all");
  const [selectedProvider, setSelectedProvider] = React.useState<StickerProvider | "all">("all");
  const [hoveredCardId, setHoveredCardId] = React.useState<string | null>(null);
  const [cachingAssetId, setCachingAssetId] = React.useState<string | null>(null);
  const [cachedAssetIds, setCachedAssetIds] = React.useState<ReadonlySet<string>>(new Set());
  const [showAiRecommendations, setShowAiRecommendations] = React.useState(false);

  // Debounce search input by 300ms
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data: categoriesData } = useStickersCategories();
  const categories = categoriesData?.categories ?? [
    "All",
    "Shocked Reactions",
    "Arrows & Pointers",
    "Viral Memes",
    "Laughing & LOL",
    "Money & Flex",
    "Mind Blown",
    "Celebration & Win",
    "Fail & Facepalm",
  ];

  const {
    data: searchData,
    isLoading: isSearchLoading,
    isError: isSearchError,
    refetch,
  } = useStickersSearch({
    query: debouncedQuery,
    type: selectedType,
    provider: selectedProvider,
    category: selectedCategory,
    limit: 28,
  });

  const { data: trendingData } = useStickersTrending(selectedType);

  const recommendMutation = useStickerRecommend();
  const cacheMutation = useCacheStickerAsset();

  const handleTriggerAiRecommend = async () => {
    setShowAiRecommendations(true);
    await recommendMutation.mutateAsync({
      transcript: transcriptText || "unbelievable crazy funny moment haha total fail",
      limit: 3,
    });
  };

  const handleSelectSticker = async (sticker: StickerAssetItem) => {
    setCachingAssetId(sticker.id);
    try {
      const res = await cacheMutation.mutateAsync({
        assetId: sticker.id,
        sourceUrl: sticker.url,
        provider: sticker.provider,
        type: sticker.type,
        isTransparent: sticker.isTransparent,
        projectId,
        title: sticker.title,
      });

      setCachedAssetIds((prev) => new Set([...prev, sticker.id]));
      onInsertSticker?.(sticker, res.cachedUrl);
    } catch {
      // Direct pass-through if edge-cache call encounters issues
      onInsertSticker?.(sticker, sticker.url);
    } finally {
      setCachingAssetId(null);
    }
  };

  const displayedAssets =
    debouncedQuery.trim() || selectedCategory !== "All"
      ? (searchData?.assets ?? [])
      : (trendingData?.assets ?? searchData?.assets ?? []);

  return (
    <div
      data-testid="stickers-drawer-root"
      className={cn(
        "flex h-full w-full max-w-md flex-col border-l border-border bg-background text-foreground shadow-xl",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Smile className="size-5 text-primary" />
          <h2 className="text-base font-semibold">Stickers, GIFs & Memes</h2>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="size-8 text-muted-foreground hover:text-foreground"
            data-testid="stickers-drawer-close"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {/* Search Input Bar */}
      <div className="p-3 border-b border-border/50">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search memes, stickers, arrows..."
            data-testid="stickers-search-input"
            className="w-full rounded-md border border-input bg-muted/40 py-2 pl-9 pr-8 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Type & Provider Toggles */}
        <div className="mt-2.5 flex items-center justify-between gap-1 text-xs">
          {/* Genre Toggle */}
          <div className="flex rounded-md bg-muted p-0.5" data-testid="stickers-type-selector">
            {(["all", "sticker", "gif", "meme"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSelectedType(t)}
                className={cn(
                  "rounded-sm px-2 py-1 font-medium capitalize transition-colors",
                  selectedType === t
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={`stickers-type-${t}`}
              >
                {t === "sticker" ? "Stickers" : t === "gif" ? "GIFs" : t === "meme" ? "Memes" : "All"}
              </button>
            ))}
          </div>

          {/* Provider Filter */}
          <div className="flex items-center gap-1">
            {(["all", "giphy", "tenor"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setSelectedProvider(p)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] uppercase transition-colors",
                  selectedProvider === p
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={`stickers-provider-${p}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* AI Recommendations Action Banner */}
        <div className="mt-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={handleTriggerAiRecommend}
            disabled={recommendMutation.isPending}
            className="w-full justify-center gap-2 border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
            data-testid="stickers-ai-recommend-button"
          >
            {recommendMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5 text-primary" />
            )}
            AI Contextual Reaction Memes
          </Button>
        </div>
      </div>

      {/* Category Scrolling Bar */}
      <div className="flex gap-1.5 overflow-x-auto border-b border-border/40 px-3 py-2 no-scrollbar">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => {
              setSelectedCategory(cat);
              if (cat !== "All") setSearchInput(cat);
            }}
            className={cn(
              "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
              selectedCategory === cat
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
            )}
            data-testid={`stickers-category-${cat.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* AI Recommendations Dropdown Box */}
      {showAiRecommendations && recommendMutation.data?.recommendations && (
        <div
          data-testid="stickers-ai-recommendations-panel"
          className="border-b border-primary/20 bg-primary/5 p-3"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-primary flex items-center gap-1.5">
              <Zap className="size-3" />
              Suggested Punchline Moments
            </span>
            <button
              type="button"
              onClick={() => setShowAiRecommendations(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {recommendMutation.data.recommendations.map((rec) => (
              <div
                key={rec.sticker.id}
                onClick={() => handleSelectSticker(rec.sticker)}
                className="group relative cursor-pointer overflow-hidden rounded-md border border-primary/30 bg-background/80 p-1 hover:border-primary"
                data-testid={`stickers-ai-item-${rec.sticker.id}`}
              >
                <img
                  src={rec.sticker.previewUrl}
                  alt={rec.sticker.title}
                  className="h-16 w-full object-contain"
                />
                <p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground">
                  {rec.reason}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stickers / Memes Grid */}
      <div className="flex-1 overflow-y-auto p-3">
        {isSearchLoading ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-primary" />
            <span className="text-xs">Searching sticker library...</span>
          </div>
        ) : displayedAssets.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <Smile className="size-8 stroke-1 text-muted-foreground/60" />
            <p className="text-xs">No matching stickers or reaction memes found.</p>
            <Button variant="outline" size="sm" onClick={() => setSearchInput("")} className="mt-1">
              Clear Search
            </Button>
          </div>
        ) : (
          <div
            data-testid="stickers-grid"
            className="grid grid-cols-2 gap-2.5 sm:grid-cols-3"
          >
            {displayedAssets.map((asset) => {
              const isHovered = hoveredCardId === asset.id;
              const isCaching = cachingAssetId === asset.id;
              const isCached = cachedAssetIds.has(asset.id);

              return (
                <div
                  key={asset.id}
                  data-testid={`sticker-card-${asset.id}`}
                  onMouseEnter={() => setHoveredCardId(asset.id)}
                  onMouseLeave={() => setHoveredCardId(null)}
                  onClick={() => handleSelectSticker(asset)}
                  className={cn(
                    "group relative flex flex-col cursor-pointer overflow-hidden rounded-lg border border-border/60 bg-muted/20 p-2 transition-all hover:border-primary hover:shadow-md",
                    // Checkered pattern for transparent items
                    asset.isTransparent
                      ? "bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#27272a_1px,transparent_1px)] [background-size:8px_8px]"
                      : "",
                  )}
                >
                  {/* Media Preview Box */}
                  <div className="relative aspect-square w-full flex items-center justify-center overflow-hidden rounded">
                    <img
                      src={isHovered ? asset.url : asset.previewUrl}
                      alt={asset.title}
                      loading="lazy"
                      className="max-h-full max-w-full object-contain transition-transform group-hover:scale-105"
                    />

                    {/* Transparent Badge */}
                    {asset.isTransparent && (
                      <span className="absolute top-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[9px] font-mono text-white/90 backdrop-blur">
                        ALPHA
                      </span>
                    )}

                    {/* Hover Add Overlay */}
                    <div
                      className={cn(
                        "absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity",
                        isHovered && "opacity-100",
                      )}
                    >
                      <Button
                        size="sm"
                        variant="primary"
                        className="h-7 text-xs font-medium shadow-sm gap-1"
                        disabled={isCaching}
                      >
                        {isCaching ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : isCached ? (
                          <Check className="size-3" />
                        ) : (
                          <Play className="size-3 fill-current" />
                        )}
                        Insert
                      </Button>
                    </div>
                  </div>

                  {/* Title & Provider Label */}
                  <div className="mt-1.5 flex items-center justify-between text-[11px]">
                    <span className="line-clamp-1 font-medium text-foreground/90" title={asset.title}>
                      {asset.title}
                    </span>
                    <span className="text-[10px] text-muted-foreground uppercase shrink-0 ml-1">
                      {asset.provider}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

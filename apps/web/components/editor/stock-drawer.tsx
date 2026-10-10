"use client";

import {
  Check,
  Clock,
  Film,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import * as React from "react";

import { Badge, Button, cn } from "@montaj/ui";

import {
  useImportStockAsset,
  useStockCategories,
  useStockSearch,
  type StockAssetItem,
  type StockOrientation,
  type StockProvider,
} from "./stock/use-stock-library";

export interface StockDrawerProps {
  readonly projectId?: string;
  readonly onInsertAsset?: (asset: StockAssetItem, cachedUrl?: string) => void;
  readonly className?: string;
  readonly initialQuery?: string;
  readonly initialOrientation?: StockOrientation;
}

export function StockDrawer({
  projectId,
  onInsertAsset,
  className,
  initialQuery = "",
  initialOrientation = "portrait",
}: StockDrawerProps): React.JSX.Element {
  const [searchInput, setSearchInput] = React.useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = React.useState(initialQuery);
  const [selectedCategory, setSelectedCategory] = React.useState("All");
  const [selectedOrientation, setSelectedOrientation] = React.useState<StockOrientation>(initialOrientation);
  const [selectedProvider, setSelectedProvider] = React.useState<StockProvider | "all">("all");
  const [hoveredCardId, setHoveredCardId] = React.useState<string | null>(null);
  const [importingAssetId, setImportingAssetId] = React.useState<string | null>(null);
  const [importedAssetIds, setImportedAssetIds] = React.useState<ReadonlySet<string>>(new Set());

  // Debounce search input
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchInput);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data: categoriesData } = useStockCategories();
  const categories = categoriesData?.categories ?? [
    "All",
    "Technology",
    "Business",
    "Nature",
    "City",
    "Finance",
    "Real Estate",
    "Abstract",
    "Fitness",
    "Space",
  ];

  const {
    data: searchData,
    isLoading,
    isError,
    refetch,
  } = useStockSearch({
    query: debouncedQuery,
    orientation: selectedOrientation,
    category: selectedCategory,
    provider: selectedProvider,
    page: 1,
    perPage: 24,
  });

  const importMutation = useImportStockAsset();

  const handleInsert = async (asset: StockAssetItem) => {
    setImportingAssetId(asset.id);
    try {
      const res = await importMutation.mutateAsync({
        assetId: asset.id,
        provider: asset.provider,
        downloadVideoUrl: asset.downloadVideoUrl,
        title: asset.title,
        durationSec: asset.durationSec,
        projectId,
        width: asset.width,
        height: asset.height,
      });

      setImportedAssetIds((prev) => new Set([...prev, asset.id]));
      if (onInsertAsset) {
        onInsertAsset(asset, res.cachedUrl);
      }
    } catch {
      // Still allow inserting using original video URL if caching encounters an edge issue
      if (onInsertAsset) {
        onInsertAsset(asset, asset.downloadVideoUrl);
      }
    } finally {
      setImportingAssetId(null);
    }
  };

  const items = searchData?.items ?? [];

  return (
    <div
      className={cn("flex h-full min-w-0 flex-col bg-bg-1 text-fg-0 overflow-hidden", className)}
      data-testid="stock-drawer"
    >
      {/* Header & Search */}
      <div className="shrink-0 border-b border-border/40 p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Film className="size-4 text-accent" />
            <span className="text-xs font-semibold tracking-wide uppercase">Integrated Stock Library</span>
          </div>
          <span className="text-2xs text-fg-2">Pexels · Pixabay · Storyblocks</span>
        </div>

        {/* Search Input Bar */}
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 size-3.5 text-fg-3" />
          <input
            type="text"
            role="searchbox"
            data-testid="stock-search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search 1080p stock footage (e.g. crypto chart, nature mist)..."
            className="h-8 w-full rounded-md border border-border/50 bg-bg-2 pl-8 pr-7 text-xs text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none"
          />
          {searchInput ? (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2 text-fg-3 hover:text-fg-0"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        {/* Orientation & Provider Controls */}
        <div className="flex items-center justify-between gap-2">
          {/* Orientation Toggle */}
          <div className="flex rounded bg-bg-2 p-0.5 text-2xs" role="radiogroup" aria-label="Orientation filter">
            <button
              type="button"
              data-testid="orientation-portrait-btn"
              onClick={() => setSelectedOrientation("portrait")}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                selectedOrientation === "portrait"
                  ? "bg-accent text-accent-fg shadow-xs"
                  : "text-fg-2 hover:text-fg-0",
              )}
            >
              Vertical 9:16
            </button>
            <button
              type="button"
              data-testid="orientation-landscape-btn"
              onClick={() => setSelectedOrientation("landscape")}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                selectedOrientation === "landscape"
                  ? "bg-accent text-accent-fg shadow-xs"
                  : "text-fg-2 hover:text-fg-0",
              )}
            >
              Widescreen 16:9
            </button>
            <button
              type="button"
              data-testid="orientation-all-btn"
              onClick={() => setSelectedOrientation("all")}
              className={cn(
                "rounded px-2 py-0.5 font-medium transition-colors",
                selectedOrientation === "all"
                  ? "bg-accent text-accent-fg shadow-xs"
                  : "text-fg-2 hover:text-fg-0",
              )}
            >
              All
            </button>
          </div>

          {/* Provider Filter Select */}
          <select
            data-testid="stock-provider-select"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value as StockProvider | "all")}
            className="h-6 rounded border border-border/40 bg-bg-2 px-1.5 text-2xs text-fg-1 focus:border-accent focus:outline-none"
            aria-label="Provider filter"
          >
            <option value="all">All Providers</option>
            <option value="pexels">Pexels</option>
            <option value="pixabay">Pixabay</option>
            <option value="storyblocks">Storyblocks</option>
          </select>
        </div>

        {/* Category Chips Scroll */}
        <div
          className="no-scrollbar flex items-center gap-1.5 overflow-x-auto pb-1"
          data-testid="stock-categories-chips"
          role="tablist"
          aria-label="Category filter chips"
        >
          {categories.map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                role="tab"
                aria-selected={isSelected}
                data-testid={`category-chip-${cat.toLowerCase().replace(/\s+/g, "-")}`}
                onClick={() => setSelectedCategory(cat)}
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-0.5 text-2xs font-medium transition-colors",
                  isSelected
                    ? "bg-accent/20 border border-accent text-accent"
                    : "bg-bg-2/80 border border-border/40 text-fg-2 hover:bg-bg-2 hover:text-fg-0",
                )}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Grid View */}
      <div className="flex-1 overflow-y-auto p-3" data-testid="stock-grid-container">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-2.5" data-testid="stock-loading-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="aspect-[9/16] animate-pulse rounded-lg bg-bg-2/60 border border-border/20"
              />
            ))}
          </div>
        ) : isError ? (
          <div className="flex h-48 flex-col items-center justify-center text-center p-4">
            <p className="text-xs text-danger mb-2">Unable to load stock media</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
              className="text-xs"
            >
              <RotateCcw className="size-3 mr-1" /> Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center text-center p-4">
            <Video className="size-8 text-fg-3/50 mb-2" />
            <p className="text-xs font-medium text-fg-1">No stock videos found</p>
            <p className="text-2xs text-fg-3 mt-1 max-w-[200px]">
              Try searching for &quot;technology&quot;, &quot;business&quot;, or choosing another category.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5" data-testid="stock-media-grid">
            {items.map((asset) => {
              const isHovered = hoveredCardId === asset.id;
              const isImporting = importingAssetId === asset.id;
              const isImported = importedAssetIds.has(asset.id);
              const isVertical = asset.aspectRatio === "9:16" || asset.height >= asset.width;

              return (
                <div
                  key={asset.id}
                  data-testid={`stock-card-${asset.id}`}
                  onMouseEnter={() => setHoveredCardId(asset.id)}
                  onMouseLeave={() => setHoveredCardId(null)}
                  className={cn(
                    "group relative flex flex-col overflow-hidden rounded-lg border border-border/40 bg-bg-2 transition-all duration-200",
                    isHovered ? "border-accent ring-1 ring-accent shadow-md" : "hover:border-border",
                  )}
                >
                  {/* Media Viewport with instant hover preview */}
                  <div
                    className={cn(
                      "relative w-full overflow-hidden bg-neutral-950",
                      isVertical ? "aspect-[9/16]" : "aspect-[16/9]",
                    )}
                  >
                    {/* Poster thumbnail image */}
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.title}
                      loading="lazy"
                      className={cn(
                        "h-full w-full object-cover transition-opacity duration-200",
                        isHovered ? "opacity-0" : "opacity-100",
                      )}
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = "none";
                      }}
                    />

                    {/* Instant on-hover low-res video preview */}
                    {isHovered ? (
                      <video
                        src={asset.previewVideoUrl}
                        autoPlay
                        loop
                        muted
                        playsInline
                        data-testid={`stock-preview-video-${asset.id}`}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : null}

                    {/* Resolution badge */}
                    <div className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1 py-0.5 text-[9px] font-semibold text-neutral-200 backdrop-blur-xs">
                      {asset.resolution ?? "1080p"}
                    </div>

                    {/* Duration badge */}
                    <div className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded bg-black/70 px-1 py-0.5 text-[9px] text-neutral-200 backdrop-blur-xs">
                      <Clock className="size-2.5" />
                      <span>{asset.durationSec.toFixed(1)}s</span>
                    </div>

                    {/* Provider badge */}
                    <div className="absolute top-1.5 right-1.5 rounded bg-black/60 px-1 py-0.5 text-[8px] font-medium text-neutral-300 capitalize backdrop-blur-xs">
                      {asset.provider}
                    </div>
                  </div>

                  {/* Card Content & Action Button */}
                  <div className="flex flex-1 flex-col justify-between p-2">
                    <h4
                      className="line-clamp-2 text-2xs font-medium text-fg-0 leading-tight"
                      title={asset.title}
                    >
                      {asset.title}
                    </h4>

                    <div className="mt-2 pt-1 border-t border-border/20">
                      <Button
                        type="button"
                        size="sm"
                        disabled={isImporting}
                        data-testid={`stock-insert-btn-${asset.id}`}
                        onClick={() => void handleInsert(asset)}
                        className={cn(
                          "w-full h-6 text-2xs font-medium transition-colors",
                          isImported
                            ? "bg-success/20 text-success border border-success/40"
                            : "bg-accent text-accent-fg hover:bg-accent/90",
                        )}
                      >
                        {isImporting ? (
                          <>
                            <Loader2 className="size-3 animate-spin mr-1" />
                            Caching...
                          </>
                        ) : isImported ? (
                          <>
                            <Check className="size-3 mr-1" />
                            Inserted
                          </>
                        ) : (
                          <>
                            <Sparkles className="size-3 mr-1" />
                            Insert Clip
                          </>
                        )}
                      </Button>
                    </div>
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

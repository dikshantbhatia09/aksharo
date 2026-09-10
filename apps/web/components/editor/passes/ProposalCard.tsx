"use client";

import * as React from "react";

import type { ItemState, PassItem } from "@montaj/edg";
import { Badge, Button, cn } from "@montaj/ui";
import type { BadgeProps } from "@montaj/ui";

const KIND_LABEL: Record<PassItem["kind"], string> = {
  cut: "Cut",
  zoom: "Zoom",
  reframe: "Reframe",
  sfx: "SFX",
  music: "Music",
  title: "Title",
};

/**
 * D04b2 scope §6: `true` when this `sfx`/`music` item's licence snapshot
 * marks it as sourced from the partner catalogue (D43: partner assets are
 * cloud-render-only, never a browser/raw-file delivery). The snapshot is
 * `Record<string, unknown>` (CONTRACTS §2's `JsonObjectSchema`) — a plain
 * object shape written by `apps/api/src/passes/partner-catalogue-items.ts`
 * (`partner: true`) or, once a real accept flow stamps one,
 * `partner-catalogue/licence-snapshot.ts` — so this reads it defensively
 * rather than trusting a typed field that does not exist on the wire.
 */
function isPartnerAsset(item: PassItem): boolean {
  if (item.kind !== "sfx" && item.kind !== "music") return false;
  const snapshot: unknown = item.payload.licenceSnapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  return (snapshot as Record<string, unknown>)["partner"] === true;
}

function formatMs(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(1);
  return minutes > 0 ? `${String(minutes)}m ${seconds}s` : `${seconds}s`;
}

export interface ProposalCardProps {
  readonly item: PassItem;
  /** Whether this card is the one keyboard J/K navigation currently points at. */
  readonly focused?: boolean;
  readonly onDecide: (state: ItemState) => void;
  /** Undo back to `proposed`, offered only once the item has been decided. */
  readonly onUndo: () => void;
  /**
   * Plays ±1.5s around the item with the change applied in the CanvasKit
   * preview (brief §2) — a callback seam rather than an embedded player: the
   * transcript editor's canvas preview (`components/editor/canvas`) owns
   * playback state and is composed by the page around `PassesTab`, not by
   * this card. `mode` distinguishes the two snippets the brief asks for.
   */
  readonly onPreview?: (mode: "before" | "after") => void;
  /**
   * D04c: a signed URL for this `sfx` item's own pack asset
   * (`packs/{packId}/{assetId}.wav`, CONTRACTS §6), resolved by the caller —
   * this card never fetches or signs a URL itself, the same seam `onPreview`
   * already uses for the CanvasKit preview. `undefined` (no resolver, or the
   * resolver returning `undefined`) simply omits the `<audio>` element rather
   * than rendering a broken player.
   */
  readonly sfxPreviewUrl?: string;
  /**
   * D04c: the gain slider's live value, in dB — a UI-only control today
   * (there is no `EdgOp` to persist an `sfx` item's `payload.gainDb`; only
   * `EditPassItem`'s `startMs`/`endMs` are writable, CONTRACTS §2), so this
   * callback is offered for a caller that wants to preview a louder/quieter
   * cue before deciding, not a durable edit.
   */
  readonly onGainDbPreview?: (gainDb: number) => void;
  /**
   * D05: a signed URL for this `music` item's own pack asset, resolved by the
   * caller — same seam as `sfxPreviewUrl`, one kind lower.
   */
  readonly musicPreviewUrl?: string;
  /**
   * D05: "swap bed" (brief §5) — re-rank within the allowed catalogue and
   * offer a different asset for this section, without leaving the review
   * surface. A callback seam: this card has no catalogue of its own to rank
   * against, so the caller (which does) supplies the swap.
   */
  readonly onSwapMusicBed?: () => void;
  readonly swappingMusicBed?: boolean;
  readonly className?: string;
}

const SFX_GAIN_MIN = -24;
const SFX_GAIN_MAX = 12;

/**
 * The signal token a review state wears (08 §1: proposed/accepted/rejected are
 * the product's three signal colours). A switch rather than a keyed record so
 * the lookup is not a dynamic-property sink.
 */
function stateTone(state: ItemState): NonNullable<BadgeProps["tone"]> {
  switch (state) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "proposed":
      return "proposed";
    default:
      return "neutral";
  }
}

/** The percentage a range input has filled, as the `--fill` custom property. */
function fillStyle(value: number, min: number, max: number): React.CSSProperties {
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  return { "--fill": `${String(Math.round(pct))}%` } as React.CSSProperties;
}

/**
 * One AI proposal: reason, confidence, accept/reject/undo (brief §2). Renders
 * identically whichever kind the item is — the kind-specific summary line is
 * the only branch — so `PassesTab` does not need a card per kind.
 */
export function ProposalCard({
  item,
  focused = false,
  onDecide,
  onUndo,
  onPreview,
  sfxPreviewUrl,
  onGainDbPreview,
  musicPreviewUrl,
  onSwapMusicBed,
  swappingMusicBed = false,
  className,
}: ProposalCardProps): React.JSX.Element {
  const decided = item.state !== "proposed";
  const sfxGainDb =
    item.kind === "sfx" && typeof item.payload.gainDb === "number" ? item.payload.gainDb : 0;
  const [gainDb, setGainDb] = React.useState(sfxGainDb);
  React.useEffect(() => setGainDb(sfxGainDb), [sfxGainDb]);

  return (
    <div
      data-testid={`proposal-card-${item.itemId}`}
      data-focused={focused ? "true" : "false"}
      data-state={item.state}
      role="listitem"
      aria-current={focused}
      className={cn(
        "bg-bg-0 flex flex-col gap-2 rounded-sm border p-2.5 transition-colors duration-[160ms]",
        focused ? "border-lime-500/45 ring-1 ring-lime-500/45" : "border-border",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{KIND_LABEL[item.kind]}</Badge>
        {isPartnerAsset(item) ? (
          <Badge tone="info" data-testid="proposal-card-partner-badge">
            Partner — cloud render only
          </Badge>
        ) : null}
        <span
          className="text-2xs text-fg-2 font-mono tabular-nums"
          data-testid="proposal-card-range"
        >
          {formatMs(item.startMs)} – {formatMs(item.endMs)}
        </span>
        {item.confidence !== undefined ? (
          <span
            className="text-2xs text-fg-2 flex items-center gap-1.5 tabular-nums"
            data-testid="proposal-card-confidence"
          >
            <span className="bg-bg-2 h-1.5 w-10 overflow-hidden rounded-full" aria-hidden="true">
              <span
                className="bg-lime-500 block h-full rounded-full"
                style={{ width: `${String(Math.round(item.confidence * 100))}%` }}
              />
            </span>
            {Math.round(item.confidence * 100)}%
          </span>
        ) : null}
        <Badge tone={stateTone(item.state)} className="ml-auto" data-testid="proposal-card-state">
          {item.state}
        </Badge>
      </div>

      {item.kind === "title" ? (
        <p className="text-fg-0 m-0 text-sm font-semibold" data-testid="proposal-card-title-text">
          “{item.payload.text}”
          {item.payload.motionPreset !== undefined ? (
            <span
              className="text-fg-2 ml-2 text-xs font-normal"
              data-testid="proposal-card-title-preset"
            >
              {item.payload.motionPreset}
            </span>
          ) : null}
        </p>
      ) : null}

      {item.kind === "sfx" ? (
        <div className="flex flex-col gap-1.5" data-testid="proposal-card-sfx">
          {sfxPreviewUrl !== undefined ? (
            <audio
              className="h-8 w-full"
              data-testid="proposal-card-sfx-preview"
              controls
              src={sfxPreviewUrl}
            />
          ) : null}
          <label className="text-fg-1 flex items-center gap-2 text-xs">
            Gain
            <input
              type="range"
              min={SFX_GAIN_MIN}
              max={SFX_GAIN_MAX}
              step={0.5}
              value={gainDb}
              aria-label="SFX gain (dB)"
              data-testid="proposal-card-sfx-gain"
              className="panel-range flex-1"
              style={fillStyle(gainDb, SFX_GAIN_MIN, SFX_GAIN_MAX)}
              onChange={(e) => {
                const next = Number(e.target.value);
                setGainDb(next);
                onGainDbPreview?.(next);
              }}
            />
            <span
              className="text-2xs text-fg-2 w-14 text-right font-mono tabular-nums"
              data-testid="proposal-card-sfx-gain-value"
            >
              {gainDb.toFixed(1)} dB
            </span>
          </label>
        </div>
      ) : null}

      {item.kind === "music" ? (
        <div className="flex flex-col gap-1.5" data-testid="proposal-card-music">
          {musicPreviewUrl !== undefined ? (
            <audio
              className="h-8 w-full"
              data-testid="proposal-card-music-preview"
              controls
              src={musicPreviewUrl}
            />
          ) : null}
          <div className="text-fg-2 flex gap-2 text-xs">
            {item.payload.mood.length > 0 ? (
              <span data-testid="proposal-card-music-mood">{item.payload.mood.join(", ")}</span>
            ) : null}
            {item.payload.bpm !== undefined ? (
              <span data-testid="proposal-card-music-bpm">{item.payload.bpm} BPM</span>
            ) : null}
            <span data-testid="proposal-card-music-loop">{item.payload.loopPolicy}</span>
          </div>
          {onSwapMusicBed !== undefined ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onSwapMusicBed}
              disabled={swappingMusicBed}
              data-testid="proposal-card-music-swap"
            >
              {swappingMusicBed ? "Swapping…" : "Swap bed"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {item.reason !== undefined ? (
        <p className="text-fg-1 m-0 text-xs" data-testid="proposal-card-reason">
          {item.reason}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {onPreview !== undefined ? (
          <>
            <Button type="button" variant="ghost" onClick={() => onPreview("before")}>
              Preview before
            </Button>
            <Button type="button" variant="ghost" onClick={() => onPreview("after")}>
              Preview after
            </Button>
          </>
        ) : null}
        <span className="flex-1" />
        {decided ? (
          <Button type="button" variant="outline" onClick={onUndo} data-testid="proposal-card-undo">
            Undo
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => onDecide("rejected")}
              data-testid="proposal-card-reject"
            >
              Reject (R)
            </Button>
            <Button
              type="button"
              onClick={() => onDecide("accepted")}
              data-testid="proposal-card-accept"
            >
              Accept (A)
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

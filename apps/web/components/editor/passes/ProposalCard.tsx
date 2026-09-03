"use client";

import * as React from "react";

import type { ItemState, PassItem } from "@montaj/edg";
import { Badge, Button } from "@montaj/ui";

const KIND_LABEL: Record<PassItem["kind"], string> = {
  cut: "Cut",
  zoom: "Zoom",
  reframe: "Reframe",
  sfx: "SFX",
  music: "Music",
  title: "Title",
};

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
  readonly className?: string;
}

const SFX_GAIN_MIN = -24;
const SFX_GAIN_MAX = 12;

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
      className={className}
      role="listitem"
      aria-current={focused}
      style={{
        border: focused ? "2px solid var(--accent, #6366f1)" : "1px solid var(--border, #333)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge>{KIND_LABEL[item.kind]}</Badge>
        <span data-testid="proposal-card-range">
          {formatMs(item.startMs)} – {formatMs(item.endMs)}
        </span>
        {item.confidence !== undefined ? (
          <span data-testid="proposal-card-confidence">{Math.round(item.confidence * 100)}%</span>
        ) : null}
        <span data-testid="proposal-card-state" style={{ marginLeft: "auto" }}>
          {item.state}
        </span>
      </div>

      {item.kind === "title" ? (
        <p
          data-testid="proposal-card-title-text"
          style={{ margin: 0, fontSize: 15, fontWeight: 600 }}
        >
          “{item.payload.text}”
          {item.payload.motionPreset !== undefined ? (
            <span
              data-testid="proposal-card-title-preset"
              style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, opacity: 0.7 }}
            >
              {item.payload.motionPreset}
            </span>
          ) : null}
        </p>
      ) : null}

      {item.kind === "sfx" ? (
        <div
          data-testid="proposal-card-sfx"
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          {sfxPreviewUrl !== undefined ? (
            <audio data-testid="proposal-card-sfx-preview" controls src={sfxPreviewUrl} />
          ) : null}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            Gain
            <input
              type="range"
              min={SFX_GAIN_MIN}
              max={SFX_GAIN_MAX}
              step={0.5}
              value={gainDb}
              aria-label="SFX gain (dB)"
              data-testid="proposal-card-sfx-gain"
              onChange={(e) => {
                const next = Number(e.target.value);
                setGainDb(next);
                onGainDbPreview?.(next);
              }}
            />
            <span data-testid="proposal-card-sfx-gain-value">{gainDb.toFixed(1)} dB</span>
          </label>
        </div>
      ) : null}

      {item.reason !== undefined ? (
        <p data-testid="proposal-card-reason" style={{ margin: 0, fontSize: 13, opacity: 0.85 }}>
          {item.reason}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8 }}>
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
        <span style={{ flex: 1 }} />
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

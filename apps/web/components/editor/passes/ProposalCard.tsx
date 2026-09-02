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
  readonly className?: string;
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
  className,
}: ProposalCardProps): React.JSX.Element {
  const decided = item.state !== "proposed";

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

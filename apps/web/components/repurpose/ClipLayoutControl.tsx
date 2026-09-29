"use client";

/**
 * A clip's layout on the run page (two-speaker layouts, 2026-10-01).
 *
 * A podcast is two people at a table filmed by one wide camera, and a vertical
 * clip of one window shows one of them at best. "Both speakers" gives each of
 * them half of the picture, one above the other; "One speaker" is one window
 * on whoever is talking; "Auto", where every clip starts, stacks two people
 * only when the video clearly shows two side by side for most of the moment.
 *
 * Three toggle buttons rather than radios: arrow keys move a radio group's
 * choice as they go, and each change here can cut the clip again. A press is
 * one request. The API cuts the clip again only when its picture would change
 * (the clip then reads "cutting" in the list, read back), and says so here
 * when "Both speakers" found only one person.
 */
import * as React from "react";

import type { RepurposeClipItem, RepurposeClipState } from "@montaj/api-client";
import { cn } from "@montaj/ui";

import { LAYOUT_COPY } from "@/components/repurpose/copy";
import { describeRefusal } from "@/components/repurpose/refusal";
import {
  CLIP_LAYOUT_CHOICES,
  layoutChoiceOf,
  layoutNoteOf,
  useClipLayout,
} from "@/components/repurpose/use-clip-layout";

/*
 * A segmented control, as the billing page's: the chosen segment is a raised
 * neutral well, not the accent (DESIGN.md > accent budget); `aria-pressed`
 * carries the state, and the well plus the weight show it without colour.
 */
const SEGMENT =
  "inline-flex min-h-8 items-center rounded-full px-3 text-xs transition-colors duration-[160ms] disabled:pointer-events-none disabled:opacity-60";
const SEGMENT_ON = "bg-bg-2 text-fg-0 font-semibold shadow-sm";
const SEGMENT_OFF = "text-fg-2 font-medium hover:text-fg-0";

export interface ClipLayoutControlProps {
  readonly runId: string;
  readonly candidateId: string;
  /** The moment's clip; nothing is shown before it has one. */
  readonly clip: RepurposeClipItem | undefined;
  /** Where that clip is (`clipStateOf`). */
  readonly clipState: RepurposeClipState | undefined;
  readonly title: string;
  /** A stopped run cuts nothing new, so its clips' layouts cannot change. */
  readonly runStopped?: boolean;
}

export function ClipLayoutControl({
  runId,
  candidateId,
  clip,
  clipState,
  title,
  runStopped = false,
}: ClipLayoutControlProps): React.JSX.Element | null {
  const layout = useClipLayout();
  const saved = clip === undefined ? "auto" : layoutChoiceOf(clip);
  // The list is read back after a change; once it shows the answer, the list
  // speaks for the clip again (another tab's change included).
  React.useEffect(() => {
    if (layout.isSuccess && layout.data.layout === saved) layout.reset();
  }, [layout, saved]);
  if (clip === undefined || runStopped) return null;

  // A change on its way, or answered but not yet read back, shows as chosen.
  const shown = layout.isPending
    ? layout.variables.layout
    : layout.isSuccess
      ? layout.data.layout
      : saved;
  // A cut in flight would race a new one (the API answers `clip_busy`).
  const busy = clipState === "cutting" || layout.isPending;
  const note = layoutNoteOf(clip, clipState);
  const refusal = layout.isError ? describeRefusal(layout.error, "layout").text : null;

  return (
    <div className="flex flex-col gap-1.5" data-testid={`clip-layout-${candidateId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-fg-2">{LAYOUT_COPY.legend}</span>
        <div
          role="group"
          aria-label={LAYOUT_COPY.groupLabel(title)}
          className="inline-flex rounded-full border border-border p-0.5"
        >
          {CLIP_LAYOUT_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={shown === choice}
              disabled={busy}
              onClick={() => {
                if (choice !== saved) layout.mutate({ runId, clipId: clip.id, layout: choice });
              }}
              className={cn(SEGMENT, shown === choice ? SEGMENT_ON : SEGMENT_OFF)}
              data-testid={`clip-layout-${choice}-${candidateId}`}
            >
              {/* eslint-disable-next-line security/detect-object-injection -- a closed enum of three choices */}
              {LAYOUT_COPY.choice[choice]}
            </button>
          ))}
        </div>
      </div>
      {note === null ? null : (
        <p className="m-0 text-xs text-fg-2" data-testid={`clip-layout-note-${candidateId}`}>
          {note === "autoStacked" ? LAYOUT_COPY.autoStacked : LAYOUT_COPY.onlyOne}
        </p>
      )}
      {refusal === null ? null : (
        <p
          role="alert"
          className="m-0 text-sm text-rejected"
          data-testid={`clip-layout-error-${candidateId}`}
        >
          {refusal}
        </p>
      )}
    </div>
  );
}

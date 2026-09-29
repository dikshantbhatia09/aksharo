"use client";

/**
 * A moment's own controls on the run page (steering, 2026-09-29, from the
 * clip tools people ask for most: "remove unwanted clips", "re-edit clip
 * times").
 *
 *   * **Remove** takes the moment and its clip off the page and stops what is
 *     still being made for it. Nothing is deleted - the moment stays, folded
 *     to one line with "Restore" ({@link RemovedMoment}) - so it is a ghost
 *     button that does not ask first. On Autopilot the next best moment is cut
 *     in its place.
 *   * **Adjust** opens nudges for the start and the end (a second or five at a
 *     time, the time each lands on shown as it moves) and "Re-cut" sends them:
 *     the server snaps them to the nearest words and cuts the clip again. A
 *     moment with no clip yet only saves its times.
 *
 * The nudges keep a moment 3 s - 3 min long and inside the video, the bounds
 * the server holds it to; anything else it refuses is said in plain words
 * (`describeRefusal`, context `steer`).
 */
import { SlidersHorizontal, Trash2, Undo2 } from "lucide-react";
import * as React from "react";

import {
  useRepurposePreview,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  type RepurposeClipState,
} from "@montaj/api-client";
import { Badge, Button } from "@montaj/ui";

import { STEERING_COPY } from "@/components/repurpose/copy";
import { formatClock } from "@/components/repurpose/moment-time";
import { describeRefusal } from "@/components/repurpose/refusal";
import { NUDGE_STEPS_MS, nudgeBounds, type MomentBounds } from "@/components/repurpose/steering";
import {
  useAdjustMoment,
  useRemoveMoment,
  useRestoreMoment,
} from "@/components/repurpose/use-steering";

export interface ClipControlsProps {
  readonly runId: string;
  readonly candidate: RepurposeCandidateItem;
  /** The moment's clip, when it has one. */
  readonly clip: RepurposeClipItem | undefined;
  /** Where that clip is (`clipStateOf`); undefined with no clip. */
  readonly clipState: RepurposeClipState | undefined;
  readonly title: string;
  /** A stopped run cuts nothing new: its moments can be removed, not re-timed. */
  readonly runStopped?: boolean;
}

export function ClipControls({
  runId,
  candidate,
  clip,
  clipState,
  title,
  runStopped = false,
}: ClipControlsProps): React.JSX.Element {
  const remove = useRemoveMoment();
  const adjust = useAdjustMoment();
  const [editing, setEditing] = React.useState(false);
  const saved = React.useMemo(
    () => ({ startMs: candidate.startMs, endMs: candidate.endMs }),
    [candidate.startMs, candidate.endMs],
  );
  const [draft, setDraft] = React.useState<MomentBounds>(saved);
  // A save that lands (or another tab's) moves the moment: the nudges start
  // from where it now is.
  React.useEffect(() => {
    setDraft(saved);
  }, [saved]);
  // The video's length bounds the end; read only while the nudges are open.
  const preview = useRepurposePreview(editing ? runId : null);
  const durationMs =
    preview.data !== undefined && preview.data.durationMs > 0 ? preview.data.durationMs : null;

  const hasClip = clip !== undefined;
  // A cut in flight would race new times (the server answers `clip_busy`).
  const cutting = clipState === "cutting";
  const changed = draft.startMs !== saved.startMs || draft.endMs !== saved.endMs;
  const refusal = adjust.isError
    ? describeRefusal(adjust.error, "steer").text
    : remove.isError
      ? describeRefusal(remove.error, "steer").text
      : null;
  const panelId = `adjust-panel-${candidate.id}`;

  const apply = (): void => {
    adjust.mutate(
      { runId, candidateId: candidate.id, startMs: draft.startMs, endMs: draft.endMs },
      {
        onSuccess: () => {
          setEditing(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`clip-controls-${candidate.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        {runStopped ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={editing}
            aria-controls={panelId}
            aria-label={STEERING_COPY.adjustLabel(title)}
            disabled={cutting && !editing}
            onClick={() => {
              adjust.reset();
              setDraft(saved);
              setEditing(!editing);
            }}
            data-testid={`adjust-moment-${candidate.id}`}
          >
            <SlidersHorizontal strokeWidth={1.75} aria-hidden="true" />
            {STEERING_COPY.adjust}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          aria-label={hasClip ? STEERING_COPY.removeClip(title) : STEERING_COPY.removeMoment(title)}
          onClick={() => {
            remove.mutate({ runId, candidateId: candidate.id });
          }}
          data-testid={`remove-moment-${candidate.id}`}
        >
          <Trash2 strokeWidth={1.75} aria-hidden="true" />
          {remove.isPending ? STEERING_COPY.removing : STEERING_COPY.remove}
        </Button>
        {cutting && !runStopped ? (
          <span className="text-xs text-fg-2" data-testid={`adjust-wait-${candidate.id}`}>
            {STEERING_COPY.adjustWhileCutting}
          </span>
        ) : null}
      </div>

      {editing ? (
        <div
          id={panelId}
          role="group"
          aria-label={STEERING_COPY.adjustLabel(title)}
          className="flex flex-col gap-2 rounded-sm border border-border bg-sunken p-3"
          data-testid={panelId}
        >
          <NudgeRow
            side="start"
            bounds={draft}
            durationMs={durationMs}
            candidateId={candidate.id}
            onChange={setDraft}
          />
          <NudgeRow
            side="end"
            bounds={draft}
            durationMs={durationMs}
            candidateId={candidate.id}
            onChange={setDraft}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              className="font-mono text-2xs text-fg-2"
              data-testid={`adjust-length-${candidate.id}`}
            >
              {STEERING_COPY.lengthNow(
                `${String(Math.round((draft.endMs - draft.startMs) / 1000))} s`,
              )}
            </span>
            {/* Secondary, not primary: every card on the page has one. */}
            <Button
              variant="secondary"
              size="sm"
              disabled={!changed || adjust.isPending}
              onClick={apply}
              data-testid={`recut-moment-${candidate.id}`}
            >
              {hasClip
                ? adjust.isPending
                  ? STEERING_COPY.recutting
                  : STEERING_COPY.recut
                : adjust.isPending
                  ? STEERING_COPY.saving
                  : STEERING_COPY.saveTimes}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                adjust.reset();
                setDraft(saved);
                setEditing(false);
              }}
              data-testid={`adjust-cancel-${candidate.id}`}
            >
              {STEERING_COPY.cancel}
            </Button>
          </div>
          <p className="m-0 text-xs text-fg-2">
            {hasClip ? STEERING_COPY.recutNote : STEERING_COPY.saveNote}
          </p>
        </div>
      ) : null}

      {refusal === null ? null : (
        <p
          role="alert"
          className="m-0 text-sm text-rejected"
          data-testid={`steer-error-${candidate.id}`}
        >
          {refusal}
        </p>
      )}
    </div>
  );
}

/** One side's nudges and the time it is at: `−5 s −1 s 1:02 +1 s +5 s`. */
function NudgeRow({
  side,
  bounds,
  durationMs,
  candidateId,
  onChange,
}: {
  readonly side: "start" | "end";
  readonly bounds: MomentBounds;
  readonly durationMs: number | null;
  readonly candidateId: string;
  readonly onChange: (next: MomentBounds) => void;
}): React.JSX.Element {
  const at = side === "start" ? bounds.startMs : bounds.endMs;
  const nudge = (step: number): React.JSX.Element => {
    const next = nudgeBounds(bounds, side, step, durationMs);
    const seconds = step / 1000;
    return (
      <Button
        key={step}
        variant="secondary"
        size="sm"
        className="h-7 px-2 font-mono"
        disabled={next === null}
        aria-label={STEERING_COPY.nudge(side, seconds)}
        onClick={() => {
          if (next !== null) onChange(next);
        }}
        data-testid={`nudge-${side}-${step < 0 ? "minus" : "plus"}${String(Math.abs(seconds))}-${candidateId}`}
      >
        {step < 0 ? "−" : "+"}
        {String(Math.abs(seconds))} s
      </Button>
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-10 text-xs text-fg-1">
        {side === "start" ? STEERING_COPY.start : STEERING_COPY.end}
      </span>
      {NUDGE_STEPS_MS.filter((step) => step < 0).map(nudge)}
      <span
        className="min-w-12 text-center font-mono text-xs text-fg-0"
        data-testid={`adjust-${side}-${candidateId}`}
      >
        {formatClock(at)}
      </span>
      {NUDGE_STEPS_MS.filter((step) => step > 0).map(nudge)}
    </div>
  );
}

/**
 * A removed moment, folded to one line: what it was, and "Restore", which
 * brings its clip back as it was.
 */
export function RemovedMoment({
  runId,
  candidate,
  title,
}: {
  readonly runId: string;
  readonly candidate: RepurposeCandidateItem;
  readonly title: string;
}): React.JSX.Element {
  const restore = useRestoreMoment();
  const refusal = restore.isError ? describeRefusal(restore.error, "steer").text : null;
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-bg-0 px-4 py-3"
      data-testid={`candidate-card-${candidate.id}`}
      data-removed="true"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-[1_1_240px] items-center gap-2">
          <Badge tone="neutral">{STEERING_COPY.removed}</Badge>
          <span className="min-w-0 truncate text-sm text-fg-2">
            {formatClock(candidate.startMs)} – {formatClock(candidate.endMs)} · {title}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={restore.isPending}
          aria-label={STEERING_COPY.restoreLabel(title)}
          onClick={() => {
            restore.mutate({ runId, candidateId: candidate.id });
          }}
          data-testid={`restore-moment-${candidate.id}`}
        >
          <Undo2 strokeWidth={1.75} aria-hidden="true" />
          {restore.isPending ? STEERING_COPY.restoring : STEERING_COPY.restore}
        </Button>
      </div>
      {refusal === null ? null : (
        <p
          role="alert"
          className="m-0 text-sm text-rejected"
          data-testid={`steer-error-${candidate.id}`}
        >
          {refusal}
        </p>
      )}
    </li>
  );
}

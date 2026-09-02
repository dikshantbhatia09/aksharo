"use client";

/**
 * The editor's three-column layout (08 §4): transcript (this work package),
 * canvas preview and the right panel (A16's `CaptionStage`/`RightPanel`,
 * integrated here rather than rebuilt — see the file-boundary note in the
 * final report). This component owns the `EditorStore`, the keyboard map,
 * find/replace, the conflict chooser and the reflow banner; it wires A16's
 * components to real ops instead of the local-only op log their own harness
 * pages (`StyleGallery`, `/studio/styles`) use.
 */
import Link from "next/link";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { newId, orderedSegments, wordsBetween } from "@montaj/edg";
import type { Segment } from "@montaj/edg";
import { resolveStyle } from "@montaj/render-core";
import type { FontRegistry, Shaper } from "@montaj/render-core";
import { fromAcceptedItems } from "@montaj/timemap";
import type { TimeMap } from "@montaj/timemap";

import type { EditorSnapshot, EditorStore } from "@/lib/edg/store";

import { CaptionStage } from "@/components/editor/canvas/CaptionStage";
import { useRenderer } from "@/components/editor/canvas/use-canvaskit";
import { type PanelOp, type PanelScope } from "@/components/editor/panels/ops";
import { RightPanel } from "@/components/editor/panels/RightPanel";
import { SYSTEM_STYLE_MAP, SYSTEM_STYLES } from "@/components/editor/panels/system-styles";
import { Timeline, type SegmentBoundsOp } from "@/components/editor/timeline/Timeline";
import {
  BulkActionsBar,
  type ResegmentParams,
} from "@/components/editor/transcript/BulkActionsBar";
import { ConflictDialog } from "@/components/editor/transcript/ConflictDialog";
import { FindReplaceDialog } from "@/components/editor/transcript/FindReplaceDialog";
import { ReflowBanner } from "@/components/editor/transcript/ReflowBanner";
import { ScriptTabs, type DisplayScript } from "@/components/editor/transcript/ScriptTabs";
import { TranscriptList } from "@/components/editor/transcript/TranscriptList";
import { planMergeShort, planSplitLong } from "@/lib/edg/bulk-actions";
import { checkReflow, parseStoredCaptionBudgets, reflowParams } from "@/lib/edg/caption-budgets";
import { findSameSpelling } from "@/lib/edg/find-replace";
import { useKeyboardShortcuts } from "@/lib/edg/keyboard-shortcuts";
import {
  deleteWord,
  editWord,
  insertWordAfter,
  mergeSegments,
  nextWordIdInChunk,
  panelOpToEdgOp,
  setEmphasis,
  splitSegment,
} from "@/lib/edg/ops";
import { PlayheadStore } from "@/lib/edg/playhead";
import { toRenderProjection } from "@/lib/edg/render-projection";
import { useEdgRealtime, useEditorStore } from "@/lib/edg/use-editor-store";
import { noopNudgeSink } from "@/lib/timeline/nudge";
import { type TimeDisplayMode } from "@/lib/timeline/output-clock";
import { useTimelineMedia } from "@/lib/timeline/use-timeline-media";

export interface EditorClientProps {
  readonly projectId: string;
}

const DEFAULT_RESEGMENT_PARAMS: ResegmentParams = {
  maxChars: 32,
  maxLines: 2,
  minMs: 800,
  maxMs: 4500,
  dropFillers: false,
};

export function EditorClient({ projectId }: EditorClientProps): React.JSX.Element {
  const load = useEditorStore(projectId);
  useEdgRealtime(projectId, load.store);

  const [playhead] = useState(() => new PlayheadStore());
  const playheadSnapshot = useSyncExternalStore(
    playhead.subscribe,
    playhead.getSnapshot,
    playhead.getSnapshot,
  );

  const [script, setScript] = useState<DisplayScript>("roman");
  const [hideFillers, setHideFillers] = useState(false);
  const [follow, setFollow] = useState(true);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | undefined>(undefined);
  const [selectedWordId, setSelectedWordId] = useState<string | undefined>(undefined);
  const [findOpen, setFindOpen] = useState(false);
  const [reflowDismissed, setReflowDismissed] = useState(false);
  const [reflowBusy, setReflowBusy] = useState(false);

  const renderer = useRenderer();

  if (load.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center" data-testid="editor-loading">
        <p className="text-fg-3 text-sm">Loading the editor…</p>
      </div>
    );
  }
  if (load.status === "error" || load.store === undefined) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="editor-error">
        <p className="text-sm text-red-400">
          {load.error?.message ?? "This project could not be opened."}
        </p>
      </div>
    );
  }

  return (
    <EditorReady
      projectId={projectId}
      store={load.store}
      snapshot={load.snapshot ?? load.store.getSnapshot()}
      playhead={playhead}
      playheadSnapshot={playheadSnapshot}
      script={script}
      setScript={setScript}
      hideFillers={hideFillers}
      setHideFillers={setHideFillers}
      follow={follow}
      setFollow={setFollow}
      selectedSegmentId={selectedSegmentId}
      setSelectedSegmentId={setSelectedSegmentId}
      selectedWordId={selectedWordId}
      setSelectedWordId={setSelectedWordId}
      findOpen={findOpen}
      setFindOpen={setFindOpen}
      reflowDismissed={reflowDismissed}
      setReflowDismissed={setReflowDismissed}
      reflowBusy={reflowBusy}
      setReflowBusy={setReflowBusy}
      registry={renderer.engine?.registry}
      shaper={renderer.engine?.shaper}
    />
  );
}

interface EditorReadyProps {
  readonly projectId: string;
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
  readonly playhead: PlayheadStore;
  readonly playheadSnapshot: ReturnType<PlayheadStore["getSnapshot"]>;
  readonly script: DisplayScript;
  readonly setScript: (script: DisplayScript) => void;
  readonly hideFillers: boolean;
  readonly setHideFillers: (value: boolean) => void;
  readonly follow: boolean;
  readonly setFollow: (value: boolean) => void;
  readonly selectedSegmentId: string | undefined;
  readonly setSelectedSegmentId: (id: string | undefined) => void;
  readonly selectedWordId: string | undefined;
  readonly setSelectedWordId: (id: string | undefined) => void;
  readonly findOpen: boolean;
  readonly setFindOpen: (open: boolean) => void;
  readonly reflowDismissed: boolean;
  readonly setReflowDismissed: (value: boolean) => void;
  readonly reflowBusy: boolean;
  readonly setReflowBusy: (value: boolean) => void;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
}

function EditorReady(props: EditorReadyProps): React.JSX.Element {
  const {
    projectId,
    store,
    snapshot,
    playhead,
    playheadSnapshot,
    script,
    setScript,
    hideFillers,
    setHideFillers,
    follow,
    setFollow,
    selectedSegmentId,
    setSelectedSegmentId,
    selectedWordId,
    setSelectedWordId,
    findOpen,
    setFindOpen,
    reflowDismissed,
    setReflowDismissed,
    reflowBusy,
    setReflowBusy,
    registry,
    shaper,
  } = props;

  const { state } = snapshot;
  const segments = useMemo(() => orderedSegments(state), [state]);
  const wordsOf = useCallback(
    (segment: Segment) => {
      try {
        return wordsBetween(state.words, segment.startWordId, segment.endWordId);
      } catch {
        return [];
      }
    },
    [state.words],
  );
  const allLiveWords = useMemo(
    () => [...state.words.values()].filter((word) => word.deleted !== true),
    [state.words],
  );

  const scope: PanelScope =
    selectedSegmentId === undefined
      ? { kind: "doc" }
      : { kind: "segment", segmentId: selectedSegmentId };
  const selectedSegment = segments.find((segment) => segment.id === selectedSegmentId);
  const catalogueSource = {
    catalogue: SYSTEM_STYLE_MAP,
    defaultStyleId: state.hot.styles.defaultStyleId,
    ...((state.hot.styles.inline as { doc?: Record<string, unknown> } | undefined)?.doc ===
    undefined
      ? {}
      : { documentOverrides: (state.hot.styles.inline as { doc?: Record<string, unknown> }).doc }),
  };
  const effectiveStyle = resolveStyle(catalogueSource, selectedSegment ?? {});

  const projection = useMemo(() => toRenderProjection(state), [state]);

  // --- Timeline (A17) ---------------------------------------------------
  const primaryMedia = state.hot.media.find((media) => media.role === "primary");
  const timelineMedia = useTimelineMedia(projectId, primaryMedia?.mediaId);
  const passItems = useMemo(() => [...state.items.values()], [state.items]);
  const timeMap: TimeMap | undefined = useMemo(() => {
    if (primaryMedia === undefined) return undefined;
    const cutItems = passItems.filter((item) => item.kind === "cut");
    if (cutItems.length === 0) return undefined;
    return fromAcceptedItems(passItems, { sourceDurationMs: primaryMedia.durationMs });
  }, [passItems, primaryMedia]);
  const [timelineDisplayMode, setTimelineDisplayMode] = useState<TimeDisplayMode>("source");

  const reflow = useMemo(() => {
    if (registry === undefined || shaper === undefined) return undefined;
    const stored = parseStoredCaptionBudgets(state.hot.meta.engineVersions);
    const docStyle = resolveStyle(catalogueSource, {});
    return checkReflow({
      stored,
      style: docStyle,
      script: stored?.script ?? "latin",
      canvas: state.hot.canvas,
      registry,
      shaper,
    });
  }, [state.hot.meta.engineVersions, state.hot.styles, state.hot.canvas, registry, shaper]);

  function submitPanelOp(op: PanelOp): void {
    store.submitOp(panelOpToEdgOp(op, state));
  }

  function onEditWord(wordId: string, text: string): void {
    store.submitOp(editWord(wordId, text, script, newId), {
      label: "Edit word",
    });
  }

  function onFixSpellingEverywhere(wordId: string, text: string): void {
    const matches = findSameSpelling(allLiveWords, text, script).filter(
      (match) => match.wordId !== wordId,
    );
    if (matches.length === 0) return;
    store.submitOps(
      matches.map((match) => editWord(match.wordId, text, script, newId)),
      { label: "Fix spelling everywhere" },
    );
    // Memory consent hook (D62/B09): recording the correction is deferred —
    // `patchTranscriptSpeakers`-style `pending` endpoint, not built yet. See
    // `lib/edg/client.ts`'s note on `A15-1`/B09.
  }

  function onSplit(): void {
    if (selectedSegmentId === undefined || selectedWordId === undefined) return;
    store.submitOp(splitSegment(selectedSegmentId, selectedWordId, newId(), newId), {
      label: "Split segment",
    });
  }

  function onSplitAt(segmentId: string, atWordId: string): void {
    store.submitOp(splitSegment(segmentId, atWordId, newId(), newId), { label: "Split segment" });
  }

  function onTimelineSetSegmentBounds(op: SegmentBoundsOp): void {
    store.submitOp(
      {
        type: "SetSegmentBounds",
        opId: newId(),
        segmentId: op.segmentId,
        startMs: op.startMs,
        endMs: op.endMs,
        ...(op.startWordId === undefined ? {} : { startWordId: op.startWordId as never }),
        ...(op.endWordId === undefined ? {} : { endWordId: op.endWordId as never }),
      },
      { label: "Move caption boundary" },
    );
  }

  function onMergeWithNext(segmentId?: string): void {
    const id = segmentId ?? selectedSegmentId;
    if (id === undefined) return;
    const index = segments.findIndex((segment) => segment.id === id);
    const next = index >= 0 ? segments[index + 1] : undefined;
    if (next === undefined) return;
    store.submitOp(mergeSegments([id, next.id], id, newId), { label: "Merge segments" });
  }

  function onEmphasize(): void {
    if (selectedSegmentId === undefined || selectedWordId === undefined) return;
    const segment = segments.find((entry) => entry.id === selectedSegmentId);
    const current = segment?.emphasis?.find((entry) => entry.wordId === selectedWordId)?.presetId;
    const defaultPreset = effectiveStyle.emphasisPresets[0]?.id;
    if (defaultPreset === undefined) return;
    const next = current === undefined ? defaultPreset : null;
    store.submitOp(setEmphasis(selectedSegmentId, selectedWordId, next, newId), {
      label: "Emphasise word",
    });
  }

  function onDeleteWord(wordId?: string): void {
    const id = wordId ?? selectedWordId;
    if (id === undefined) return;
    store.submitOp(deleteWord(id, newId), { label: "Delete word" });
    setSelectedWordId(undefined);
  }

  function onInsertWordAfter(afterWordId: string, text: string): void {
    const anchor = state.words.get(afterWordId as never);
    if (anchor === undefined) return;
    const newWordId = nextWordIdInChunk(state.words, afterWordId);
    store.submitOp(insertWordAfter(afterWordId, newWordId, text, anchor.e, anchor.e + 200, newId), {
      label: "Insert word",
    });
  }

  function onHideToggle(segmentId: string, hidden: boolean): void {
    store.submitOp(
      { type: "HideSegment", opId: newId(), segmentId, hidden },
      { label: hidden ? "Hide caption" : "Show caption" },
    );
  }

  function onMergeShort(): void {
    const ops = planMergeShort({ segments, newId });
    if (ops.length > 0) store.submitOps(ops, { label: "Merge short captions" });
  }

  function onSplitLong(): void {
    const ops = planSplitLong({ segments, wordsOf, newId });
    if (ops.length > 0) store.submitOps(ops, { label: "Split long captions" });
  }

  async function onResegment(params: ResegmentParams): Promise<void> {
    setReflowBusy(true);
    try {
      await store.resegment(params);
    } finally {
      setReflowBusy(false);
    }
  }

  async function onReflow(): Promise<void> {
    if (reflow === undefined) return;
    setReflowBusy(true);
    try {
      await store.resegment(
        reflowParams(reflow.current, {
          minMs: DEFAULT_RESEGMENT_PARAMS.minMs,
          maxMs: DEFAULT_RESEGMENT_PARAMS.maxMs,
        }),
      );
      setReflowDismissed(false);
    } finally {
      setReflowBusy(false);
    }
  }

  useKeyboardShortcuts(
    {
      split: onSplit,
      merge: () => {
        onMergeWithNext();
      },
      emphasize: onEmphasize,
      deleteWord: () => {
        onDeleteWord();
      },
      find: () => {
        setFindOpen(true);
      },
      undo: () => {
        store.undo();
      },
      redo: () => {
        store.redo();
      },
      playPause: () => {
        playhead.togglePlaying();
      },
      jogBack: () => {
        playhead.seek(playheadSnapshot.ms - 1000);
      },
      jogPause: () => {
        playhead.setPlaying(false);
      },
      jogForward: () => {
        playhead.seek(playheadSnapshot.ms + 1000);
      },
    },
    true,
  );

  const activeSegment = segments.find(
    (segment) => playheadSnapshot.ms >= segment.startMs && playheadSnapshot.ms < segment.endMs,
  );

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col" data-testid="editor-root">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        <Link
          href="/studio"
          className="text-fg-3 text-sm hover:underline"
          data-testid="editor-back"
        >
          ← Projects
        </Link>
        <ScriptTabs value={script} onChange={setScript} available={state.hot.transcript.scripts} />
        <label className="text-fg-3 ml-4 flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={hideFillers}
            data-testid="hide-fillers-toggle"
            onChange={(event) => setHideFillers(event.target.checked)}
          />
          Hide fillers
        </label>
        <label className="text-fg-3 flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={follow}
            data-testid="follow-toggle"
            onChange={(event) => setFollow(event.target.checked)}
          />
          Follow playhead
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="editor-undo"
            disabled={!snapshot.canUndo}
            title="Undo (Ctrl+Z)"
            className="rounded-md bg-white/5 px-2 py-1 text-xs disabled:opacity-30"
            onClick={() => store.undo()}
          >
            ⟲ Undo
          </button>
          <button
            type="button"
            data-testid="editor-redo"
            disabled={!snapshot.canRedo}
            title="Redo (Ctrl+Y)"
            className="rounded-md bg-white/5 px-2 py-1 text-xs disabled:opacity-30"
            onClick={() => store.redo()}
          >
            ⟳ Redo
          </button>
          {snapshot.offline ? (
            <span
              data-testid="editor-offline"
              className="rounded-full bg-amber-400/20 px-2 py-1 text-xs text-amber-300"
            >
              Offline — retrying…
            </span>
          ) : null}
        </div>
      </header>

      {snapshot.tooStale ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-red-400/30 bg-red-400/10 px-4 py-2 text-sm"
          data-testid="editor-too-stale"
        >
          <span>This editor fell too far behind to catch up automatically.</span>
          <button
            type="button"
            data-testid="editor-reload"
            className="rounded-md bg-white px-2.5 py-1 font-medium text-black"
            onClick={() => void store.reload()}
          >
            Reload
          </button>
        </div>
      ) : null}

      {reflow?.needed === true && !reflowDismissed ? (
        <div className="px-4 pt-2">
          <ReflowBanner
            visible
            busy={reflowBusy}
            onReflow={() => void onReflow()}
            onDismiss={() => setReflowDismissed(true)}
          />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[420px] shrink-0 flex-col gap-2 border-r border-white/10 p-3">
          <BulkActionsBar
            onMergeShort={onMergeShort}
            onSplitLong={onSplitLong}
            onResegment={(params) => void onResegment(params)}
            defaultParams={DEFAULT_RESEGMENT_PARAMS}
          />
          <TranscriptList
            className="flex-1"
            segments={segments}
            wordsOf={wordsOf}
            script={script}
            hideFillers={hideFillers}
            follow={follow}
            {...(selectedSegmentId === undefined ? {} : { selectedSegmentId })}
            {...(selectedWordId === undefined ? {} : { selectedWordId })}
            {...(activeSegment === undefined ? {} : { activeSegmentId: activeSegment.id })}
            onSelectSegment={setSelectedSegmentId}
            onSelectWord={(segmentId, wordId) => {
              setSelectedSegmentId(segmentId);
              setSelectedWordId(wordId);
            }}
            onSeek={(ms) => playhead.seek(ms)}
            onEditWord={onEditWord}
            onFixSpellingEverywhere={onFixSpellingEverywhere}
            onMergeWithNext={(segmentId) => onMergeWithNext(segmentId)}
            onHideToggle={onHideToggle}
            onInsertWordAfter={onInsertWordAfter}
          />
        </div>

        <div className="min-w-0 flex-1 bg-black/40 p-4">
          <CaptionStage
            src={timelineMedia.proxyUrl ?? ""}
            projection={projection}
            catalogue={SYSTEM_STYLE_MAP}
            {...(selectedSegmentId === undefined ? {} : { selectedSegmentId })}
            onOp={(op) => {
              store.submitOp({
                type: "SetSegmentPosition",
                opId: op.opId,
                segmentId: op.segmentId,
                position: op.position,
              });
            }}
          />
        </div>

        <div className="flex w-80 shrink-0 flex-col gap-2 border-l border-white/10 p-3">
          {reflow?.current.belowComfortableMinimum === true ? (
            <p
              data-testid="below-comfortable-minimum-hint"
              className="rounded-md bg-amber-400/10 px-2 py-1.5 text-xs text-amber-300"
            >
              This style shows one short word per caption.
            </p>
          ) : null}
          <RightPanel
            styles={SYSTEM_STYLES}
            style={effectiveStyle}
            scope={scope}
            onOp={submitPanelOp}
          />
        </div>
      </div>

      <div className="border-t border-white/10 bg-black/30 p-2" data-testid="editor-timeline-row">
        <Timeline
          words={allLiveWords}
          segments={segments}
          passItems={passItems}
          {...(timelineMedia.waveform === undefined ? {} : { waveform: timelineMedia.waveform })}
          durationMs={primaryMedia?.durationMs ?? 0}
          playheadMs={playheadSnapshot.ms}
          playing={playheadSnapshot.playing}
          onSeek={(ms) => playhead.seek(ms)}
          onTogglePlay={() => playhead.togglePlaying()}
          {...(selectedSegmentId === undefined ? {} : { selectedSegmentId })}
          {...(selectedWordId === undefined ? {} : { selectedWordId })}
          onSelectSegment={setSelectedSegmentId}
          onSelectWord={(segmentId, wordId) => {
            setSelectedSegmentId(segmentId);
            setSelectedWordId(wordId);
          }}
          onSetSegmentBounds={onTimelineSetSegmentBounds}
          onSplitSegment={onSplitAt}
          onMergeSegments={([a]) => onMergeWithNext(a)}
          {...(timeMap === undefined ? {} : { timeMap })}
          displayMode={timelineDisplayMode}
          onDisplayModeChange={setTimelineDisplayMode}
          nudgeSink={noopNudgeSink}
        />
      </div>

      <FindReplaceDialog
        open={findOpen}
        words={allLiveWords}
        script={script}
        onClose={() => setFindOpen(false)}
        onReplaceAll={(matches) => {
          store.submitOps(
            matches.map((match) => editWord(match.wordId, match.replacement, script, newId)),
            { label: "Replace all" },
          );
        }}
      />

      <ConflictDialog
        conflicts={snapshot.conflicts}
        onResolve={(opId, choice) => store.resolveConflict(opId, choice)}
        onDismiss={(opId) => store.dismissConflict(opId)}
      />
    </div>
  );
}

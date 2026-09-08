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
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ApiError, useProject, useRecordSpellingFixMemory } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import { newId, orderedSegments, wordsBetween } from "@montaj/edg";
import type { Segment } from "@montaj/edg";
import { resolveStyle } from "@montaj/render-core";
import type { FontRegistry, Shaper } from "@montaj/render-core";
import { fromAcceptedItems } from "@montaj/timemap";
import type { TimeMap } from "@montaj/timemap";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  toast,
} from "@montaj/ui";

import { NeedsTranscription } from "./needs-transcription";

import type { SetAudioCleanOp } from "@/components/editor/audio/use-audio-clean";
import type { SegmentCardAction } from "@/components/editor/transcript/SegmentCard";
import type { EditorSnapshot, EditorStore } from "@/lib/edg/store";

import { CaptionStage } from "@/components/editor/canvas/CaptionStage";
import { CropWindowOverlay } from "@/components/editor/canvas/CropWindowOverlay";
import { aspectRatioOf, containWidth } from "@/components/editor/canvas/stage-fit";
import { useRenderer } from "@/components/editor/canvas/use-canvaskit";
import { FirstRunCoachMarks } from "@/components/editor/coach-marks/FirstRunCoachMarks";
import { EditorCommandPalette } from "@/components/editor/EditorCommandPalette";
import { EditorMenubar } from "@/components/editor/EditorMenubar";
import { ExportButton } from "@/components/editor/export/ExportButton";
import {
  buildPresetDoc,
  deleteMyPreset,
  loadMyPresets,
  saveMyPreset,
} from "@/components/editor/panels/my-presets";
import { type PanelOp, type PanelScope } from "@/components/editor/panels/ops";
import { RightPanel } from "@/components/editor/panels/RightPanel";
import { SYSTEM_STYLE_MAP, SYSTEM_STYLES } from "@/components/editor/panels/system-styles";
import { CustomFontsPanel } from "@/components/editor/rail/CustomFontsPanel";
import { EditorRail, type EditorRailTab } from "@/components/editor/rail/EditorRail";
import { LibraryPanel } from "@/components/editor/rail/LibraryPanel";
import { RetranscribeDialog } from "@/components/editor/RetranscribeDialog";
import { ShareDialog } from "@/components/editor/ShareDialog";
import {
  Timeline,
  type PassItemBoundsOp,
  type SegmentBoundsOp,
  type WordTimingOp,
} from "@/components/editor/timeline/Timeline";
import { PlayerToolbar } from "@/components/editor/toolbar/PlayerToolbar";
import {
  BulkActionsBar,
  type ResegmentParams,
} from "@/components/editor/transcript/BulkActionsBar";
import { ConflictDialog } from "@/components/editor/transcript/ConflictDialog";
import { FindReplaceDialog } from "@/components/editor/transcript/FindReplaceDialog";
import { ReflowBanner } from "@/components/editor/transcript/ReflowBanner";
import { ScriptTabs } from "@/components/editor/transcript/scripts/ScriptTabs";
import { TranscriptList } from "@/components/editor/transcript/TranscriptList";
import { isWordDisplayScript } from "@/components/editor/transcript/WordChip";
import {
  percent,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePersistedLayout,
  type WorkspaceLayout,
  type WorkspaceLayoutHandle,
} from "@/components/editor/workspace/resizable";
import { planMergeShort, planSplitLong } from "@/lib/edg/bulk-actions";
import { checkReflow, parseStoredCaptionBudgets, reflowParams } from "@/lib/edg/caption-budgets";
import { findSameSpelling } from "@/lib/edg/find-replace";
import { useKeyboardShortcuts } from "@/lib/edg/keyboard-shortcuts";
import {
  deleteWord,
  editPassItem,
  editWord,
  insertWordAfter,
  mergeSegments,
  nextWordIdInChunk,
  panelOpToEdgOp,
  setEmphasis,
  setProtectedRanges,
  setWordTiming,
  splitSegment,
  toggleProtectedRange,
} from "@/lib/edg/ops";
import { PlayheadStore } from "@/lib/edg/playhead";
import { toRenderProjection } from "@/lib/edg/render-projection";
import { useEdgRealtime, useEditorStore } from "@/lib/edg/use-editor-store";
import { EDITOR_ACTIONS, EDITOR_MENUS, type EditorActionContext } from "@/lib/editor/actions";
import { readPrivacy, subscribePrivacy } from "@/lib/privacy/consent";
import { currentCropRect } from "@/lib/timeline/current-crop-rect";
import { noopNudgeSink } from "@/lib/timeline/nudge";
import { type TimeDisplayMode } from "@/lib/timeline/output-clock";
import { useTimelineMedia } from "@/lib/timeline/use-timeline-media";

export interface EditorClientProps {
  readonly projectId: string;
  /** D82: server-read `AUDIO_DEEP_CLEAN_ENABLED` flag for the Audio panel's Deep clean tier. */
  readonly deepCleanEnabled?: boolean;
}

/**
 * B09b: whether `onFixSpellingEverywhere` should post
 * `POST /memory/hooks/spelling-fix` — consent-gated, and only for an actual
 * change of spelling (a no-op "fix" that leaves the text unchanged is not a
 * correction worth remembering, `MemoryService.recordSpellingFix`'s own rule
 * on the server side). Exported as a pure predicate so it is unit-testable
 * without mounting the editor's canvas-heavy component tree.
 */
export function shouldRecordSpellingFix(
  memoryConsent: boolean,
  wrong: string | undefined,
  right: string,
): wrong is string {
  return memoryConsent && wrong !== undefined && wrong.trim() !== "" && wrong !== right;
}

/**
 * OC3: what the timeline row's right-click menu may offer. The timeline is a
 * canvas with no per-clip DOM, so its menu acts on the *selected* segment —
 * and when there is none it says where the word-level actions live instead of
 * offering rows that would do nothing. Exported as a pure rule for the same
 * reason `shouldRecordSpellingFix` above is: this component's tree is
 * canvas-heavy and belongs to the Playwright lane, and this is the whole of
 * the menu's enabled/disabled logic.
 */
export function timelineMenuState(selectedSegmentId: string | undefined): {
  readonly disabled: boolean;
  readonly hint?: string;
} {
  return selectedSegmentId === undefined
    ? { disabled: true, hint: "Right-click a transcript card for word-level actions" }
    : { disabled: false };
}

const DEFAULT_RESEGMENT_PARAMS: ResegmentParams = {
  maxChars: 32,
  maxLines: 2,
  minMs: 800,
  maxMs: 4500,
  dropFillers: false,
};

// OC-01: the workspace's proportions. react-resizable-panels v4 addresses a
// layout by panel id — `setLayout` takes a map and the persisted layout is keyed
// by them — so every panel below carries one of these stable ids.
const WORKSPACE_PANEL_MAIN = "editor-main-row";
const WORKSPACE_PANEL_TIMELINE = "editor-timeline-panel";
const COLUMN_PANEL_TRANSCRIPT = "editor-transcript-panel";
const COLUMN_PANEL_STAGE = "editor-stage-panel";
const COLUMN_PANEL_STYLE = "editor-style-panel";

/** main row / timeline, % */
const WORKSPACE_DEFAULT = { main: 62, timeline: 38 } as const;

/** transcript / stage / panel, % */
const COLUMNS_DEFAULT = { transcript: 26, stage: 52, style: 22 } as const;

/** The same numbers keyed the way v4's `setLayout` wants them (panel id → %). */
const WORKSPACE_DEFAULT_LAYOUT = {
  [WORKSPACE_PANEL_MAIN]: WORKSPACE_DEFAULT.main,
  [WORKSPACE_PANEL_TIMELINE]: WORKSPACE_DEFAULT.timeline,
} satisfies WorkspaceLayout;

const COLUMNS_DEFAULT_LAYOUT = {
  [COLUMN_PANEL_TRANSCRIPT]: COLUMNS_DEFAULT.transcript,
  [COLUMN_PANEL_STAGE]: COLUMNS_DEFAULT.stage,
  [COLUMN_PANEL_STYLE]: COLUMNS_DEFAULT.style,
} satisfies WorkspaceLayout;

export function EditorClient({
  projectId,
  deepCleanEnabled = false,
}: EditorClientProps): React.JSX.Element {
  const load = useEditorStore(projectId);
  useEdgRealtime(projectId, load.store);

  const [playhead] = useState(() => new PlayheadStore());
  const playheadSnapshot = useSyncExternalStore(
    playhead.subscribe,
    playhead.getSnapshot,
    playhead.getSnapshot,
  );

  const [script, setScript] = useState<string>("roman");
  // FIX-04: "roman" was a hard-coded default rendered even when no roman script
  // exists (the tab said Roman over Devanagari text). The tabs report what the
  // transcript actually has; follow them.
  const onScriptsAvailable = useCallback((available: readonly string[]) => {
    setScript((current) => (available.includes(current) ? current : (available[0] ?? current)));
  }, []);
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
    // "No editing document" is not a broken project, it is one whose first
    // transcription never ran — offer the work instead of a red dead end.
    if (load.error instanceof ApiError && load.error.code === "edg/not_initialised") {
      return <NeedsTranscription projectId={projectId} />;
    }
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
      onScriptsAvailable={onScriptsAvailable}
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
      deepCleanEnabled={deepCleanEnabled}
    />
  );
}

interface EditorReadyProps {
  readonly projectId: string;
  readonly store: EditorStore;
  readonly snapshot: EditorSnapshot;
  readonly playhead: PlayheadStore;
  readonly playheadSnapshot: ReturnType<PlayheadStore["getSnapshot"]>;
  /** A22's ScriptTabs also offers "translated" (a segment-level caption); SegmentCard branches on it. */
  readonly script: string;
  readonly setScript: (script: string) => void;
  /** FIX-04: corrects `script` when the transcript does not have it. */
  readonly onScriptsAvailable: (available: readonly string[]) => void;
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
  readonly deepCleanEnabled: boolean;
}

function EditorReady(props: EditorReadyProps): React.JSX.Element {
  // The projects "⋯" menu's Export lands here with `?export=1` so it opens the
  // dialog rather than dropping the user in the editor to hunt for it (F07-E5).
  // OC-02 gives Share the same door: the kebab's Share now navigates with
  // `?share=1`, read here exactly the same way.
  const searchParams = useSearchParams();
  const openExportOnMount = searchParams.get("export") === "1";
  const openShareOnMount = searchParams.get("share") === "1";
  const {
    projectId,
    store,
    snapshot,
    playhead,
    playheadSnapshot,
    script,
    setScript,
    onScriptsAvailable,
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
    deepCleanEnabled,
  } = props;

  // OC-01: the resizable workspace. The imperative handles reset both groups to
  // the defaults above on a double-clicked handle (OpenCut desktop parity); the
  // `usePersistedLayout` ids are literals, because a group that saves under one
  // key and restores from another remembers nothing.
  const workspaceRef = useRef<WorkspaceLayoutHandle>(null);
  const columnsRef = useRef<WorkspaceLayoutHandle>(null);

  // OC-02: what the menubar opens. Each dialog was already controlled from
  // somewhere — the export dialog by its own button, the re-transcribe dialog
  // by its own — so this is where "the menu opens it" now lives.
  const router = useRouter();
  const [exportOpen, setExportOpen] = useState(openExportOnMount);
  const [shareOpen, setShareOpen] = useState(openShareOnMount);
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // K04: the left rail's active tab, and the player's Safe Zone toggle —
  // `true` matches `CaptionStage`'s own previous hardcoded default, so a
  // freshly opened editor looks exactly as it did before this toggle existed.
  const [railTab, setRailTab] = useState<EditorRailTab>("captions");
  const [safeZonesOn, setSafeZonesOn] = useState(true);
  const workspaceLayout = usePersistedLayout("montaj-editor-workspace-v1");
  const columnsLayout = usePersistedLayout("montaj-editor-columns-v1");
  const resetWorkspace = useCallback(() => {
    workspaceRef.current?.setLayout({ ...WORKSPACE_DEFAULT_LAYOUT });
    columnsRef.current?.setLayout({ ...COLUMNS_DEFAULT_LAYOUT });
  }, []);

  // Word-level ops (`EditWord`) only ever fire while a word-level script tab
  // is active — "translated" swaps the transcript view to a segment-level
  // block (`SegmentCard.tsx`) with no `WordChip`s to edit — so this fallback
  // is defensive, never actually exercised by the UI.
  const wordScript = isWordDisplayScript(script) ? script : "roman";

  // B09b: the memory consent gate (`lib/privacy/consent.ts`'s browser mirror,
  // the same source `settings/memory` reads) for `onFixSpellingEverywhere`'s
  // learning-hook post below.
  const [privacy, setPrivacy] = useState(() => readPrivacy());
  useEffect(() => {
    setPrivacy(readPrivacy());
    return subscribePrivacy(setPrivacy);
  }, []);
  const recordSpellingFix = useRecordSpellingFixMemory();

  // FIX-04: the header's Re-transcribe dialog opens on the project's own
  // language, so the user changes it from what it *is* rather than from blank.
  const project = useProject(projectId).data;

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

  // K01: "My Presets" — `StylePicker.tsx`'s "Save as template" button
  // (`style-picker-save-template`) was never wired to anything
  // (`editor-client.tsx` never passed `onSaveTemplate`). Per the wave
  // README's golden-rule addendum this stays client-local rather than a new
  // `POST /workspaces/{id}/style-presets` route: scoped per **project**
  // (`my-presets.ts`'s own doc comment explains why, not per workspace —
  // `projectId` is the only stable id already in scope here), read once on
  // mount/project-switch and kept in state so a save is reflected immediately.
  const [myPresets, setMyPresets] = useState<StyleDoc[]>([]);
  useEffect(() => {
    setMyPresets(loadMyPresets(projectId));
  }, [projectId]);

  const scope: PanelScope =
    selectedSegmentId === undefined
      ? { kind: "doc" }
      : { kind: "segment", segmentId: selectedSegmentId };
  const selectedSegment = segments.find((segment) => segment.id === selectedSegmentId);
  const timelineMenu = timelineMenuState(selectedSegmentId);
  // K01: "My Presets" is a client-local catalogue on top of the system one —
  // no new API route (wave README's golden-rule addendum) — so a segment or
  // the document can point `styleRef` at a saved preset's id and still
  // resolve, the exact path `resolveStyle` already uses for a system style.
  const catalogue = useMemo(() => {
    if (myPresets.length === 0) return SYSTEM_STYLE_MAP;
    return new Map([
      ...SYSTEM_STYLE_MAP,
      ...myPresets.map((preset) => [preset.id, preset] as const),
    ]);
  }, [myPresets]);
  const catalogueSource = {
    catalogue,
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

  // B20b: the current zoom/reframe crop window, drawn as a canvas overlay
  // whenever an accepted item covers the playhead (an inline curve only —
  // `currentCropRect`'s own doc comment explains why a `keyframesRef` item
  // draws nothing here rather than fetching bytes from a pure function).
  const currentCrop = useMemo(
    () => currentCropRect(passItems, playheadSnapshot.ms),
    [passItems, playheadSnapshot.ms],
  );
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
    // `components/editor/panels/ops.ts`'s `OpId` doc comment: "Client-generated
    // op id; the editor swaps in a real ULID." Every panel control (`ops.ts`'s
    // `setStyleRef`/segment-position/emphasis builders, called with no
    // `newOpId` factory) mints its op with the module's own `panel-${n}`
    // placeholder, which the server's `edg/ops` validator rejects outright
    // (`opId` must be a ULID) — this is the one place that does the swap, so
    // every panel gets a real id without each control needing to thread a
    // factory through.
    store.submitOp(panelOpToEdgOp({ ...op, opId: newId() }, state));
  }

  // --- My Presets (K01) ----------------------------------------------------
  // "Save as template" → name prompt → serialize the current effective style
  // → `my-presets.ts`'s client-local store → appears in the Style tab's My
  // Presets sub-tab, selectable like any system style (`catalogue` above
  // merges it in). `window.prompt`/`window.alert` rather than a new dialog
  // component: the brief's own wording for this flow is "name prompt", and a
  // one-field prompt is all this needs.
  function onSaveTemplate(): void {
    const name = window.prompt("Name this preset");
    if (name === null) return;
    const result = buildPresetDoc(name, effectiveStyle);
    if (!result.ok || result.doc === undefined) {
      window.alert(result.error ?? "Could not save that preset.");
      return;
    }
    setMyPresets(saveMyPreset(projectId, result.doc));
  }

  function onDeletePreset(id: string): void {
    setMyPresets(deleteMyPreset(projectId, id));
  }

  // --- Audio (B10b) -------------------------------------------------------
  // The Audio panel builds a `SetAudio` payload with no `opId`/`type` — it
  // does not talk to the queue directly (`AudioPanel.tsx`'s own doc comment)
  // — so this is the one place that mints a real op id and hands it to
  // `EdgOpQueue` via `store.submitOp`, exactly as `submitPanelOp` does above.
  function onSetAudio(op: SetAudioCleanOp): void {
    store.submitOp(
      { type: "SetAudio", opId: newId(), clean: op.clean },
      { label: op.clean.enabled ? "Apply audio clean" : "Remove audio clean" },
    );
  }

  const audioClean = (state.hot.audio as { clean?: { cleanId?: string | null } } | undefined)
    ?.clean;
  const appliedCleanId = typeof audioClean?.cleanId === "string" ? audioClean.cleanId : undefined;

  function onEditWord(wordId: string, text: string): void {
    store.submitOp(editWord(wordId, text, wordScript, newId), {
      label: "Edit word",
    });
  }

  function onFixSpellingEverywhere(wordId: string, text: string): void {
    const wrong = allLiveWords.find((word) => word.wid === wordId)?.t;
    const matches = findSameSpelling(allLiveWords, text, wordScript).filter(
      (match) => match.wordId !== wordId,
    );
    if (matches.length === 0) return;
    store.submitOps(
      matches.map((match) => editWord(match.wordId, text, wordScript, newId)),
      { label: "Fix spelling everywhere" },
    );

    // B09b: `POST /memory/hooks/spelling-fix`, consent-gated the same way
    // `useMemoryNudgeSink` gates the timing nudge, and only after the batch
    // above has actually landed — `store.flush()` (`lib/edg/store.ts`)
    // bypasses the debounce and resolves once the round trip completes, so
    // this never records a correction the server went on to reject.
    if (shouldRecordSpellingFix(privacy.memory, wrong, text)) {
      void store.flush().then(() => {
        recordSpellingFix.mutate({ wrong, right: text, script: wordScript });
      });
    }
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

  function onTimelineSetWordTiming(op: WordTimingOp): void {
    store.submitOp(setWordTiming(op.wordId, op.s, op.e, newId), { label: "Retime word" });
  }

  function onTimelineEditPassItem(op: PassItemBoundsOp): void {
    store.submitOp(editPassItem(op.itemId, op.startMs, op.endMs, newId), {
      label: "Adjust pass item",
    });
  }

  function onToggleProtection(s: number, e: number): void {
    const current = state.hot.protected ?? [];
    const next = toggleProtectedRange(current, s, e, newId);
    store.submitOp(setProtectedRanges(next, newId), { label: "Toggle protected range" });
  }

  function onMergeWithNext(segmentId?: string): void {
    const id = segmentId ?? selectedSegmentId;
    if (id === undefined) return;
    const index = segments.findIndex((segment) => segment.id === id);
    const next = index >= 0 ? segments[index + 1] : undefined;
    if (next === undefined) return;
    // `MergeSegments.newSegmentId` must be a *free* id (`requireFreeSegmentId`,
    // packages/edg/src/ops/apply.ts) — both `id` and `next.id` are still live
    // segments at the moment the op is checked, so reusing either here always
    // gets the op rejected as not-free and the merge silently never applies.
    store.submitOp(mergeSegments([id, next.id], newId(), newId), { label: "Merge segments" });
  }

  // OC3: an explicit target, defaulting to the selection — the same shape
  // `onDeleteWord(wordId?)` and `onMergeWithNext(segmentId?)` already have.
  // The context menu cannot rely on the default: it sets the selection and
  // dispatches in one go, and React has not applied that `setState` yet.
  function onEmphasize(segmentId?: string, wordId?: string): void {
    const targetSegmentId = segmentId ?? selectedSegmentId;
    const targetWordId = wordId ?? selectedWordId;
    if (targetSegmentId === undefined || targetWordId === undefined) return;
    const segment = segments.find((entry) => entry.id === targetSegmentId);
    const current = segment?.emphasis?.find((entry) => entry.wordId === targetWordId)?.presetId;
    const defaultPreset = effectiveStyle.emphasisPresets[0]?.id;
    if (defaultPreset === undefined) return;
    const next = current === undefined ? defaultPreset : null;
    store.submitOp(setEmphasis(targetSegmentId, targetWordId, next, newId), {
      label: "Emphasise word",
    });
  }

  /**
   * OC3: the transcript card's context menu asking for one of the three ops
   * the editor owns rather than the card. It moves the selection to what the
   * menu was opened on — exactly what a click on that word would have done —
   * and then calls the very handler the keyboard map calls, so a right-click
   * and a shortcut can never mean two different things.
   */
  function onSegmentCardAction(
    action: SegmentCardAction,
    segmentId: string,
    wordId?: string,
  ): void {
    setSelectedSegmentId(segmentId);
    if (wordId !== undefined) setSelectedWordId(wordId);
    if (action === "split") {
      if (wordId !== undefined) onSplitAt(segmentId, wordId);
      return;
    }
    if (action === "emphasize") {
      onEmphasize(segmentId, wordId);
      return;
    }
    onDeleteWord(wordId);
  }

  function onDeleteWord(wordId?: string): void {
    const id = wordId ?? selectedWordId;
    if (id === undefined) return;
    store.submitOp(deleteWord(id, newId), { label: "Delete word" });
    setSelectedWordId(undefined);
  }

  /** The word after `wordId` in document order, across segment boundaries. */
  function wordFollowing(wordId: string): { readonly s: number } | undefined {
    for (const [index, segment] of segments.entries()) {
      const words = wordsOf(segment);
      const at = words.findIndex((word) => word.wid === wordId);
      if (at === -1) continue;
      const next = words.at(at + 1);
      if (next !== undefined) return next;
      const following = segments.at(index + 1);
      return following === undefined ? undefined : wordsOf(following).at(0);
    }
    return undefined;
  }

  function onInsertWordAfter(afterWordId: string, text: string): void {
    const anchor = state.words.get(afterWordId as never);
    if (anchor === undefined) return;
    const newWordId = nextWordIdInChunk(state.words, afterWordId);
    // A fixed 200 ms word overran its follower on any transcript denser than
    // 200 ms/word, and `apply.ts` refuses that (`invalid-range`) — so "Insert
    // word after" never succeeded on real speech (OC-03 finding). Clamp the new
    // word to the gap; a zero gap yields a zero-length word, which the op allows.
    const follower = wordFollowing(afterWordId);
    const end =
      follower === undefined
        ? anchor.e + 200
        : Math.max(anchor.e, Math.min(anchor.e + 200, follower.s));
    store.submitOp(insertWordAfter(afterWordId, newWordId, text, anchor.e, end, newId), {
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

  // OC-02: the menubar's half of the same handlers the keyboard map above
  // binds. Deliberately the *same* functions and not re-implementations —
  // "shortcuts shown match behaviour" is only true by construction, and the
  // registry (`lib/editor/actions.ts`) owns which key each item advertises.
  const editorActionContext: EditorActionContext = {
    canSplit: selectedSegmentId !== undefined,
    canWordEdit: selectedWordId !== undefined,
    hideFillers,
    follow,
    playing: playheadSnapshot.playing,
    togglePlay: () => {
      playhead.togglePlaying();
    },
    jog: (deltaMs) => {
      playhead.seek(playheadSnapshot.ms + deltaMs);
    },
    undo: () => {
      store.undo();
    },
    redo: () => {
      store.redo();
    },
    // `onSplit()`, not `onSplitAt()`: the selection-based split is what S does,
    // and a menu item that splits somewhere else than the shortcut would be a
    // second behaviour wearing the same label.
    split: onSplit,
    mergeWithNext: () => {
      onMergeWithNext();
    },
    emphasize: onEmphasize,
    deleteWord: () => {
      onDeleteWord();
    },
    openFind: () => {
      setFindOpen(true);
    },
    setHideFillers,
    setFollow,
    openExport: () => {
      setExportOpen(true);
    },
    openShare: () => {
      setShareOpen(true);
    },
    openRetranscribe: () => {
      setRetranscribeOpen(true);
    },
    openShortcuts: () => {
      setShortcutsOpen(true);
    },
    goToProjects: () => {
      router.push("/projects");
    },
  };

  const activeSegment = segments.find(
    (segment) => playheadSnapshot.ms >= segment.startMs && playheadSnapshot.ms < segment.endMs,
  );
  // The per-word highlight follows the played frame (F02 follow-up): the cards
  // already accept `activeWordId`; nothing ever passed it.
  const activeWordId =
    activeSegment === undefined
      ? undefined
      : wordsOf(activeSegment).find(
          (word) => playheadSnapshot.ms >= word.s && playheadSnapshot.ms < word.e,
        )?.wid;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col" data-testid="editor-root">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2">
        {/* The header's own "← Projects" link is gone: File → Back to projects
            is the same navigation, and two ways out of the editor side by side
            is the duplicate chrome the menubar exists to replace. */}
        <EditorMenubar ctx={editorActionContext} />
        <EditorCommandPalette ctx={editorActionContext} />
        <ScriptTabs
          projectId={projectId}
          activeScript={script}
          onScriptChange={setScript}
          onAvailable={onScriptsAvailable}
        />
        <RetranscribeDialog
          projectId={projectId}
          sourceLanguage={project?.sourceLanguage ?? null}
          open={retranscribeOpen}
          onOpenChange={setRetranscribeOpen}
        />
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
          <span data-coach-mark="export" className="inline-flex">
            <ExportButton
              open={exportOpen}
              onOpenChange={setExportOpen}
              projectId={projectId}
              primaryMediaId={state.hot.media.find((media) => media.role === "primary")?.mediaId}
              projection={toRenderProjection(state)}
              catalogue={SYSTEM_STYLE_MAP}
              registry={registry}
              shaper={shaper}
            />
          </span>
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
          {/* Not decorative: the queue.ts debounce (250 ms) makes "has the edit
              reached the server yet" a real race for anything that follows an
              edit immediately (a reload, most sharply) — this is what the e2e
              suite polls instead of a fixed sleep. */}
          <span
            data-testid="editor-pending-count"
            data-pending={String(snapshot.pendingCount)}
            className="sr-only"
          >
            {snapshot.pendingCount}
          </span>
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

      <ResizablePanelGroup
        groupRef={workspaceRef}
        id="montaj-editor-workspace-v1"
        orientation="vertical"
        className="min-h-0 flex-1"
        {...workspaceLayout}
      >
        <ResizablePanel
          id={WORKSPACE_PANEL_MAIN}
          defaultSize={percent(WORKSPACE_DEFAULT.main)}
          minSize={percent(35)}
        >
          <ResizablePanelGroup
            groupRef={columnsRef}
            id="montaj-editor-columns-v1"
            orientation="horizontal"
            {...columnsLayout}
          >
            <ResizablePanel
              id={COLUMN_PANEL_TRANSCRIPT}
              defaultSize={percent(COLUMNS_DEFAULT.transcript)}
              minSize={percent(16)}
            >
              <div className="h-full min-w-0 border-r border-white/10" data-coach-mark="transcript">
                {/* K04: the left icon rail (Captions/Custom Fonts/Library) — the
                    Captions tab's content below is byte-for-byte what this column
                    rendered directly before the rail existed. */}
                <EditorRail
                  active={railTab}
                  onActiveChange={setRailTab}
                  captions={
                    <div className="flex h-full min-w-0 flex-col gap-2 p-3">
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
                        {...(activeSegment === undefined
                          ? {}
                          : { activeSegmentId: activeSegment.id })}
                        {...(activeWordId === undefined ? {} : { activeWordId })}
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
                        onRequestAction={onSegmentCardAction}
                      />
                    </div>
                  }
                  fonts={<CustomFontsPanel className="p-3" />}
                  library={<LibraryPanel className="p-3" />}
                />
              </div>
            </ResizablePanel>

            <ResizableHandle onResetLayout={resetWorkspace} />

            <ResizablePanel
              id={COLUMN_PANEL_STAGE}
              defaultSize={percent(COLUMNS_DEFAULT.stage)}
              minSize={percent(30)}
            >
              <div
                className="min-w-0 h-full bg-black/40 p-4 flex flex-col"
                style={{ containerType: "size" }}
              >
                {/* K04: resolution indicator, Safe Zone toggle and Replace-media —
                    all "near the player" rather than buried in a menu. */}
                <PlayerToolbar
                  canvas={state.hot.canvas}
                  safeZonesOn={safeZonesOn}
                  onSafeZonesChange={setSafeZonesOn}
                  projectId={projectId}
                  mediaId={primaryMedia?.mediaId}
                />
                <div className="min-h-0 flex-1 flex items-center justify-center">
                  {/* FIX-05: the stage box takes the DOCUMENT's aspect, so a 9:16 project
                      is a tall frame in a centered column, not a strip lost in a
                      landscape void. CaptionStage still letterboxes internally, so a
                      mid-migration mismatch degrades gracefully instead of cropping. */}
                  <div
                    className="relative max-h-full max-w-full"
                    style={{
                      aspectRatio: aspectRatioOf(projection.canvas),
                      width: containWidth(projection.canvas, "100cqw", "100cqh"),
                    }}
                    data-testid="editor-stage-box"
                  >
                    <CaptionStage
                      src={timelineMedia.proxyUrl}
                      playing={playheadSnapshot.playing}
                      seekMs={playheadSnapshot.ms}
                      seekSeq={playheadSnapshot.seekSeq}
                      onTimeUpdate={(ms) => playhead.syncFromMedia(ms)}
                      onEnded={() => playhead.setPlaying(false)}
                      onPlayBlocked={(reason) => {
                        playhead.setPlaying(false);
                        toast.error("Could not start playback", { description: reason });
                      }}
                      onMediaError={() => timelineMedia.refresh()}
                      projection={projection}
                      catalogue={SYSTEM_STYLE_MAP}
                      script={script}
                      showSafeZones={safeZonesOn}
                      {...(selectedSegmentId === undefined ? {} : { selectedSegmentId })}
                      onOp={(op) => {
                        // The stage's drag op arrives with the panel module's
                        // `panel-${n}` placeholder id (see `submitPanelOp`); the
                        // server rejects it, so every drag 400'd and no caption
                        // position was ever saved (S04 finding). Mint the real id
                        // here exactly as `submitPanelOp` does.
                        store.submitOp({
                          type: "SetSegmentPosition",
                          opId: newId(),
                          segmentId: op.segmentId,
                          position: op.position,
                        });
                      }}
                    >
                      {({ fit, canvas }) => (
                        <CropWindowOverlay cropRect={currentCrop} canvas={canvas} fit={fit} />
                      )}
                    </CaptionStage>
                  </div>
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle onResetLayout={resetWorkspace} />

            <ResizablePanel
              id={COLUMN_PANEL_STYLE}
              defaultSize={percent(COLUMNS_DEFAULT.style)}
              minSize="20rem"
              maxSize={percent(32)}
            >
              <div
                className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto border-l border-white/10 p-3"
                data-coach-mark="style"
              >
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
                  canvas={projection.canvas}
                  onOp={submitPanelOp}
                  onSaveTemplate={onSaveTemplate}
                  myPresets={myPresets}
                  onDeletePreset={onDeletePreset}
                  audio={{
                    projectId,
                    ...(primaryMedia?.mediaId === undefined
                      ? {}
                      : { mediaId: primaryMedia.mediaId }),
                    ...(appliedCleanId === undefined ? {} : { appliedCleanId }),
                    onSetAudio,
                    deepCleanEnabled,
                  }}
                />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle onResetLayout={resetWorkspace} />

        {/*
         * `max-h` + its own scroll (M18): the timeline's canvas height is data-
         * driven (`laneTops.totalHeight` — more lanes with more pass types or
         * protected ranges make it taller) and this row previously had no cap
         * at all, so on an ordinary laptop viewport a lane-heavy timeline (or
         * one showing alongside the reflow banner, B19b/B20b territory) could
         * eat most of `editor-root`'s fixed `100dvh-3.5rem` height, squeezing
         * the flex-1 row above — transcript, canvas preview and the style
         * picker — down to a few px. Below its own content's minimum, the
         * style grid's tiles (each with `overflow-hidden`, whose CSS Grid
         * automatic minimum size is then 0, not their content size) collapsed
         * to ~2px: still "visible, enabled and stable" by Playwright's own
         * actionability checks, but with nothing rendered and their real
         * screen position off in the timeline row, so a click on them hit
         * whatever now occupied that point instead (`gate-a.spec.ts`'s
         * `style-picker-tile-*` journey step — M18). Capping this row and
         * letting its own content scroll keeps that budget for the panels
         * that need it, for every viewport, not only test ones.
         *
         * OC-01: the 38dvh cap became the timeline panel's default/min/max sizes.
         */}
        <ResizablePanel
          id={WORKSPACE_PANEL_TIMELINE}
          defaultSize={percent(WORKSPACE_DEFAULT.timeline)}
          minSize={percent(18)}
          maxSize={percent(55)}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              {/*
               * OC3: the timeline canvas treats *any* pointerdown as a
               * selection gesture (`Timeline.tsx`'s `onPointerDown` filters no
               * button), so a right-click on empty canvas ran
               * `onSelectSegment(undefined)` — clearing the very selection this
               * menu acts on, before it could open — and scrubbed the playhead
               * when the press landed on the ruler. Swallowing non-primary
               * buttons in the capture phase leaves that handler to real clicks
               * and drags; the `contextmenu` event radix listens for is a
               * different event and is untouched.
               */}
              <div
                className="h-full overflow-y-auto border-t border-white/10 bg-black/30 p-2"
                data-testid="editor-timeline-row"
                onPointerDownCapture={(event) => {
                  if (event.button !== 0) event.stopPropagation();
                }}
              >
                <Timeline
                  words={allLiveWords}
                  segments={segments}
                  passItems={passItems}
                  protectedRanges={state.hot.protected ?? []}
                  onToggleProtection={onToggleProtection}
                  {...(timelineMedia.waveform === undefined
                    ? {}
                    : { waveform: timelineMedia.waveform })}
                  {...(timelineMedia.thumbs === undefined
                    ? {}
                    : { thumbnails: timelineMedia.thumbs })}
                  wordScript={wordScript}
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
                  onSetWordTiming={onTimelineSetWordTiming}
                  onEditPassItem={onTimelineEditPassItem}
                  onSplitSegment={onSplitAt}
                  onMergeSegments={([a]) => onMergeWithNext(a)}
                  {...(timeMap === undefined ? {} : { timeMap })}
                  displayMode={timelineDisplayMode}
                  onDisplayModeChange={setTimelineDisplayMode}
                  nudgeSink={noopNudgeSink}
                  onMergeShortCaptions={onMergeShort}
                  onSplitLongCaptions={onSplitLong}
                  onResegmentCaptions={(params) => void onResegment(params)}
                  resegmentDefaultParams={DEFAULT_RESEGMENT_PARAMS}
                  bulkActionsBusy={reflowBusy}
                  onCaptionToolsAction={(ops, label) => store.submitOps(ops, { label })}
                />
              </div>
            </ContextMenuTrigger>

            {/*
             * OC3: the timeline canvas has no per-clip DOM to hang a menu on,
             * so the row offers the same operations for whatever segment is
             * selected. Every item calls a handler that already exists above —
             * nothing here is a second implementation.
             */}
            <ContextMenuContent data-testid="timeline-context-menu">
              <ContextMenuItem
                data-testid="timeline-menu-split"
                disabled={timelineMenu.disabled}
                onSelect={onSplit}
              >
                Split segment <ContextMenuShortcut>S</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="timeline-menu-merge"
                disabled={timelineMenu.disabled}
                onSelect={() => onMergeWithNext(selectedSegmentId)}
              >
                Merge with next <ContextMenuShortcut>M</ContextMenuShortcut>
              </ContextMenuItem>

              <ContextMenuSeparator />

              <ContextMenuItem
                data-testid="timeline-menu-protect"
                disabled={timelineMenu.disabled}
                onSelect={() => {
                  if (selectedSegment !== undefined)
                    onToggleProtection(selectedSegment.startMs, selectedSegment.endMs);
                }}
              >
                Toggle protection <ContextMenuShortcut>P</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                data-testid="timeline-menu-hide"
                disabled={timelineMenu.disabled}
                onSelect={() => {
                  if (selectedSegment !== undefined)
                    onHideToggle(selectedSegment.id, selectedSegment.hidden !== true);
                }}
              >
                {selectedSegment?.hidden === true ? "Show segment" : "Hide segment"}
              </ContextMenuItem>

              {timelineMenu.hint === undefined ? null : (
                <ContextMenuLabel
                  data-testid="timeline-menu-hint"
                  className="text-fg-3 text-xs font-normal tracking-normal normal-case"
                >
                  {timelineMenu.hint}
                </ContextMenuLabel>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </ResizablePanel>
      </ResizablePanelGroup>

      <FindReplaceDialog
        open={findOpen}
        words={allLiveWords}
        script={wordScript}
        onClose={() => setFindOpen(false)}
        onReplaceAll={(matches) => {
          store.submitOps(
            matches.map((match) => editWord(match.wordId, match.replacement, wordScript, newId)),
            { label: "Replace all" },
          );
        }}
      />

      <ConflictDialog
        conflicts={snapshot.conflicts}
        onResolve={(opId, choice) => store.resolveConflict(opId, choice)}
        onDismiss={(opId) => store.dismissConflict(opId)}
      />

      <ShareDialog projectId={projectId} open={shareOpen} onOpenChange={setShareOpen} />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      <FirstRunCoachMarks />
    </div>
  );
}

/**
 * Help → Keyboard shortcuts: the registry, read back to the user. It lists
 * `EDITOR_ACTIONS` rather than a hand-written table precisely so it cannot
 * fall out of date — an action added to the registry appears here on its own.
 */
function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every editor action, and the key it answers to. Actions with no key are menu-only.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          {EDITOR_MENUS.map((menu) => (
            <section key={menu.id}>
              <h3 className="text-fg-3 text-2xs mb-1 font-medium tracking-wide uppercase">
                {menu.label}
              </h3>
              <dl className="flex flex-col gap-1">
                {EDITOR_ACTIONS.filter((action) => action.menu === menu.id).map((action) => (
                  <div key={action.id} className="flex items-baseline justify-between gap-4">
                    <dt className="text-fg-1 text-sm">{action.label}</dt>
                    <dd className="text-fg-3 text-2xs tracking-widest">{action.shortcut ?? "—"}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

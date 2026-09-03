/**
 * The ONLY file in this package allowed to touch UXP/Premiere globals
 * (`require("premierepro")`, `require("uxp")`). Everything else — the bridge client, the
 * sign-in state machine, the upload flow and every UI component — takes a `PremiereHost`
 * and is fully testable without Premiere or UXP installed (brief: "no Premiere Pro ... exist
 * on the build host").
 *
 * Reference documentation (cited per call; no signature here is invented beyond what these
 * pages describe — exact behaviour is unverified until the A00-03 human spike runs on a real
 * Premiere 25.6+ install, see `docs/GATE-C-CHECKLIST.md`):
 *   - UXP for Premiere Pro overview & plugin structure:
 *     https://developer.adobe.com/premiere-pro/uxp/guides/uxp_guide/uxp-for-scripting/plugin-structure/
 *   - JavaScript restrictions (no eval, no dynamic import of remote code):
 *     https://developer.adobe.com/premiere-pro/uxp/guides/uxp_guide/uxp-for-scripting/javascript-restrictions/
 *   - Premiere Pro object model (Application, Project, Sequence, TrackItem):
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/application/
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/sequence/
 *   - EncoderManager (audio-only mixdown export):
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/encodermanager/
 *   - executeTransaction / Action model (used by C06 apply modes; referenced here only so the
 *     interface shape matches what C06 will need):
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/#executetransaction
 *   - UXP secure storage (`uxp.storage.secureStorage`) — NOT used by this adapter; see the
 *     note on `PremiereHost` session handling below.
 *   - UXP network/fetch policy (manifest `requiredPermissions.network.domains`):
 *     https://developer.adobe.com/premiere-pro/uxp/guides/uxp_guide/uxp-for-scripting/network/
 *   - Text-Based Editing transcript import (C06 transcript injection):
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/transcript/
 *     (`Transcript.createImportTextSegmentsAction`, cited by the C06 brief; exact segment/word
 *     JSON shape is unverified until Gate C — see docs/GATE-C-CHECKLIST.md).
 *   - MOGRT insert + parameters (C06 MOGRT captions):
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/#importmgtitem
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/componentparam/
 *   - Ripple delete / Motion keyframes (C06 cuts/zooms):
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/trackitem/
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/component/
 *   - Marker metadata for the host-id map (C06 re-sync):
 *     https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/marker/
 *
 * THREAT-MODEL.md T13 ("Panel secret exposure... panels hold tokens in memory only; bridge
 * holds credentials") and 03-architecture/12-redesign-decisions.md D25 ("panels keep tokens
 * in memory only") together are the frozen constraint that governs this adapter: even though
 * UXP exposes `uxp.storage.secureStorage`, this plugin never persists a session or pair token
 * there. `src/auth/session.ts` holds the session in a plain in-memory object that is dropped
 * on panel reload/close, matching every other host panel (C05a/b). This is a deviation from
 * the WP brief's "session held in UXP secure storage" line — flagged in the final report as a
 * brief/threat-model conflict, resolved in favour of the frozen threat model.
 */

/** Frame-accurate timecode/frame count, per Premiere's "ticks"-free integer frame model. */
export interface FrameRange {
  readonly startFrames: number;
  readonly endFrames: number;
}

export interface SequenceFrameRate {
  /** e.g. 25, 29.97, 23.976 */
  readonly fps: number;
  readonly dropFrame: boolean;
}

export interface SequenceInfo {
  readonly sequenceId: string;
  readonly name: string;
  readonly frameRate: SequenceFrameRate;
  readonly width: number;
  readonly height: number;
  /** Sequence in/out; `undefined` when no work area is set. */
  readonly inOut: FrameRange | undefined;
}

export interface ClipRef {
  readonly trackItemId: string;
  readonly trackIndex: number;
  readonly name: string;
}

export type SequenceChangeKind = "sequenceActivated" | "selectionChanged" | "inOutChanged";

export interface SequenceChangeEvent {
  readonly kind: SequenceChangeKind;
  readonly sequence: SequenceInfo | undefined;
}

/** Mono 16 kHz for cloud transcription (A06/A11); 48 kHz stereo for the "cloud clean" pass. */
export type MixdownFormat = "mono16k" | "stereo48k";

export interface MixdownRequest {
  readonly sequenceId: string;
  readonly range: FrameRange;
  readonly format: MixdownFormat;
}

export interface MixdownResult {
  /** A local temp-file path; never uploaded directly — `media.stat`/`media.uploadTicket` own that. */
  readonly tempFilePath: string;
  readonly format: MixdownFormat;
  readonly durationMs: number;
}

export type MixdownProgressListener = (progress: { readonly fraction: number }) => void;

// ---------------------------------------------------------------------------------------
// C06 apply-mode types
// ---------------------------------------------------------------------------------------

/** One word of an EDG segment, reduced to what Text-Based Editing transcript import needs. */
export interface TranscriptWordInput {
  readonly wid: string;
  readonly text: string;
  readonly startFrames: number;
  readonly endFrames: number;
}

export interface TranscriptSegmentInput {
  readonly segmentId: string;
  readonly speaker?: string;
  readonly words: readonly TranscriptWordInput[];
}

export interface TranscriptImportRequest {
  readonly sequenceId: string;
  readonly language: string;
  readonly range: FrameRange;
  readonly segments: readonly TranscriptSegmentInput[];
}

export interface TranscriptImportResult {
  readonly transcriptItemId: string;
  /** True when this import replaced a previously Aksharo-tagged transcript on the sequence. */
  readonly replacedExisting: boolean;
}

export interface MogrtInsertRequest {
  readonly mogrtPath: string;
  readonly trackIndex: number;
  readonly startFrames: number;
  readonly durationFrames: number;
}

export interface MogrtInsertResult {
  readonly itemId: string;
}

/** Values for the appendix param table: `Text, Font, Size, Colour, ..., HighlightStart/End`. */
export type MogrtParamValue = string | number;
export type MogrtParams = Readonly<Record<string, MogrtParamValue>>;

export type MotionEase = "linear" | "inOut";

export interface MotionKeyframeInput {
  readonly atFrames: number;
  readonly scale: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly ease: MotionEase;
}

export interface MediaBinImportRequest {
  /** A local path (downloaded via the bridge, or produced by a mixdown) to import into the bin. */
  readonly sourcePath: string;
  readonly binName?: string;
}

export interface MediaBinImportResult {
  readonly itemId: string;
}

export interface PlaceOnTrackRequest {
  readonly itemId: string;
  readonly trackIndex: number;
  readonly startFrames: number;
  readonly durationFrames: number;
}

export interface PlaceOnTrackResult {
  readonly trackItemId: string;
}

export interface ReplaceAudioRangeRequest {
  readonly sourcePath: string;
  readonly range: FrameRange;
  readonly muteOriginalTrackIndex: number;
}

// ---------------------------------------------------------------------------------------
// D09 apply-mode types (sfx/music audio clips, title MOGRT instances)
// ---------------------------------------------------------------------------------------

export type TrackKind = "video" | "audio";

export interface EnsureTrackRequest {
  readonly kind: TrackKind;
  /** e.g. "Aksharo SFX" / "Aksharo Music" (`@montaj/shared-apply`'s `AudioClipOp.trackName`). */
  readonly name: string;
}

export interface EnsureTrackResult {
  readonly trackIndex: number;
  /** True when a track with this exact name already existed and was reused (idempotent re-apply). */
  readonly reused: boolean;
}

export interface GainKeyframeInput {
  readonly atFrames: number;
  readonly gainDb: number;
}

/** Marker-guid payload (brief: "host-id map in marker guids"). `rev` is the EDG revision the
 * item was last synced against, so a re-sync can tell a stale item from a current one. */
export interface AksharoItemMetadata {
  readonly aksharo: {
    readonly projectId: string;
    readonly segmentId?: string;
    readonly itemId?: string;
    readonly rev: number;
  };
}

export interface AksharoTrackedItem {
  readonly trackItemId: string;
  readonly metadata: AksharoItemMetadata;
}

/**
 * The seam every UXP-specific call goes through. `MockPremiereHost` implements it for tests;
 * a real implementation (not built here — no Premiere/UXP toolchain exists on this host, see
 * the package README) will call `require("premierepro")` and `require("uxp")` behind this
 * same surface, verified manually per `docs/GATE-C-CHECKLIST.md`.
 */
export interface PremiereHost {
  /** Premiere's own version string (e.g. "25.6.0"), for the version banner (`src/version`). */
  getHostVersion(): Promise<string>;

  /** The active sequence, or `undefined` when no project/sequence is open. */
  getActiveSequence(): Promise<SequenceInfo | undefined>;

  /** Currently selected clips in the active sequence's timeline, in track order. */
  getSelectedClips(): Promise<ClipRef[]>;

  /**
   * Subscribes to sequence/selection/in-out changes. Returns an unsubscribe function.
   * Real adapter: Premiere Pro event manager (`Application.instance...addEventListener`,
   * see the Application/Sequence reference above); exact event names are unverified until
   * Gate C.
   */
  onSequenceChange(listener: (event: SequenceChangeEvent) => void): () => void;

  /**
   * Requests an EncoderManager mixdown of `range` to a temp WAV file. Real adapter:
   * `EncoderManager.exportSequenceFrameAsFile`-family calls per the EncoderManager reference
   * above; the exact preset/method used for an audio-only WAV mixdown is unverified until
   * Gate C, so this call is mocked, not fabricated, in every test.
   */
  requestMixdown(
    request: MixdownRequest,
    onProgress?: MixdownProgressListener,
  ): Promise<MixdownResult>;

  /** Opens a URL in the OS default browser (device-code sign-in). UXP `shell.openExternal`. */
  openExternalUrl(url: string): Promise<void>;

  /**
   * Reads a local file the panel itself produced (the mixdown temp WAV) as bytes, for the
   * presigned upload PUT. Real adapter: `uxp.storage.localFileSystem` (`getEntryWithUrl` +
   * `read({format: storage.formats.binary})`), scoped to the plugin's temp folder only —
   * see https://developer.adobe.com/premiere-pro/uxp/guides/uxp_guide/uxp-for-scripting/file-system-access/.
   */
  readFile(path: string): Promise<Uint8Array>;

  // --- C06 apply modes ------------------------------------------------------------------

  /**
   * Imports EDG segments/words as a Text-Based Editing transcript on the sequence's in/out
   * range. Idempotent: a second call with the same `sequenceId` replaces only the
   * Aksharo-tagged transcript (real adapter: `Transcript.createImportTextSegmentsAction`,
   * see header citation).
   */
  importTranscript(request: TranscriptImportRequest): Promise<TranscriptImportResult>;

  /** Inserts one MOGRT instance on `trackIndex` at `startFrames`/`durationFrames`. */
  insertMogrt(request: MogrtInsertRequest): Promise<MogrtInsertResult>;

  /** Sets a MOGRT instance's component params, resolved by the caller (displayName + index
   * fallback happens in `src/apply/mogrtCaptions.ts`, not here). */
  setMogrtParams(itemId: string, params: MogrtParams): Promise<void>;

  /** Reads a MOGRT instance's params back, for the start-up self-test and idempotent re-apply. */
  getMogrtParams(itemId: string): Promise<MogrtParams | undefined>;

  /** Ripple-deletes the given frame ranges from the active sequence (accepted cuts). */
  rippleDelete(ranges: readonly FrameRange[]): Promise<void>;

  /** Sets Motion scale/position keyframes on a track item (accepted zooms, MKF2-decoded). */
  setMotionKeyframes(itemId: string, keyframes: readonly MotionKeyframeInput[]): Promise<void>;

  /** Imports a local file into the project bin (SRT sidecar, alpha-overlay render, cleaned
   * audio) without placing it on any track. */
  importMediaToBin(request: MediaBinImportRequest): Promise<MediaBinImportResult>;

  /** Places a bin item onto a track at a given frame range. */
  placeOnTrack(request: PlaceOnTrackRequest): Promise<PlaceOnTrackResult>;

  /** Imports the cleaned-audio WAV and mutes the original audio track for `range` (B10/B10b). */
  replaceAudioRange(request: ReplaceAudioRangeRequest): Promise<void>;

  /**
   * Runs `fn` inside one Premiere undo/redo transaction (real adapter:
   * `Project#executeTransaction`, see header citation); a thrown error rolls every host
   * mutation made inside `fn` back before rethrowing.
   */
  transaction<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /** Writes the Aksharo host-id map into a track item's marker guid. */
  setItemMetadata(trackItemId: string, metadata: AksharoItemMetadata): Promise<void>;

  /** Reads a track item's Aksharo host-id map, if any. */
  getItemMetadata(trackItemId: string): Promise<AksharoItemMetadata | undefined>;

  /** Lists every track item carrying Aksharo marker metadata, for re-sync diffing. */
  listAksharoItems(): Promise<readonly AksharoTrackedItem[]>;

  /** Removes a track item (re-sync: an item whose EDG source was deleted). */
  removeItem(trackItemId: string): Promise<void>;

  // --- D09 apply modes (sfx/music, titles) -----------------------------------------------

  /**
   * Finds (by name) or creates a dedicated track for accepted sfx/music clips
   * (brief §Scope 1: "dedicated audio tracks"). Idempotent: a second call with the same
   * `name` returns the existing track's index (`reused: true`) rather than creating a
   * duplicate — a re-apply must not pile up "Aksharo SFX 2", "Aksharo SFX 3", ... tracks.
   */
  ensureTrack(request: EnsureTrackRequest): Promise<EnsureTrackResult>;

  /**
   * Sets gain (volume) keyframes on an audio track item: sfx/music clip gain + fades
   * (brief §Scope 1: "gain and fades as clip audio keyframes"), and ducking approximated as
   * gain keyframes on the dialogue track item this same call targets.
   */
  setClipGainKeyframes(trackItemId: string, keyframes: readonly GainKeyframeInput[]): Promise<void>;
}

export interface MockPremiereHostOptions {
  readonly hostVersion?: string;
  readonly initialSequence?: SequenceInfo | undefined;
  readonly initialSelection?: ClipRef[];
  readonly mixdownResult?: Partial<MixdownResult>;
  readonly mixdownProgressSteps?: number[];
}

const DEFAULT_SEQUENCE: SequenceInfo = {
  sequenceId: "seq-mock-1",
  name: "Mock Sequence",
  frameRate: { fps: 25, dropFrame: false },
  width: 1080,
  height: 1920,
  inOut: { startFrames: 0, endFrames: 250 },
};

/**
 * In-memory `PremiereHost` used by every test in this package and by Storybook-less local
 * panel development (there is no Premiere to attach to on this build host). Deterministic:
 * no timers, no randomness beyond an incrementing counter for temp file names.
 */
export class MockPremiereHost implements PremiereHost {
  private hostVersion: string;
  private sequence: SequenceInfo | undefined;
  private selection: ClipRef[];
  private readonly listeners = new Set<(event: SequenceChangeEvent) => void>();
  private readonly mixdownResult: Partial<MixdownResult>;
  private readonly mixdownProgressSteps: number[];
  private mixdownCounter = 0;
  readonly openedUrls: string[] = [];

  constructor(options: MockPremiereHostOptions = {}) {
    this.hostVersion = options.hostVersion ?? "25.6.0";
    this.sequence = "initialSequence" in options ? options.initialSequence : DEFAULT_SEQUENCE;
    this.selection = options.initialSelection ?? [];
    this.mixdownResult = options.mixdownResult ?? {};
    this.mixdownProgressSteps = options.mixdownProgressSteps ?? [0.25, 0.5, 0.75, 1];
  }

  async getHostVersion(): Promise<string> {
    return this.hostVersion;
  }

  async getActiveSequence(): Promise<SequenceInfo | undefined> {
    return this.sequence;
  }

  async getSelectedClips(): Promise<ClipRef[]> {
    return this.selection;
  }

  onSequenceChange(listener: (event: SequenceChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async requestMixdown(
    request: MixdownRequest,
    onProgress?: MixdownProgressListener,
  ): Promise<MixdownResult> {
    for (const fraction of this.mixdownProgressSteps) {
      onProgress?.({ fraction });
    }
    this.mixdownCounter += 1;
    const durationFrames = request.range.endFrames - request.range.startFrames;
    const fps = this.sequence?.frameRate.fps ?? 25;
    return {
      tempFilePath: `/tmp/mock-mixdown-${this.mixdownCounter}.wav`,
      format: request.format,
      durationMs: Math.round((durationFrames / fps) * 1000),
      ...this.mixdownResult,
    };
  }

  async openExternalUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const existing = this.fileContents.get(path);
    if (existing) return existing;
    // Deterministic placeholder bytes so a test can assert size/shape without a real WAV.
    return new TextEncoder().encode(`mock-audio-bytes:${path}`);
  }

  /** Test helper: pre-seed bytes for a given temp path (e.g. one `requestMixdown` returned). */
  setFileContents(path: string, bytes: Uint8Array): void {
    this.fileContents.set(path, bytes);
  }

  private readonly fileContents = new Map<string, Uint8Array>();

  // --- C06 apply-mode state ---------------------------------------------------------------

  private itemCounter = 0;
  private currentTranscriptItemId: string | undefined;
  private readonly mogrtParams = new Map<string, MogrtParams>();
  private readonly itemMetadata = new Map<string, AksharoItemMetadata>();
  private readonly binItems = new Set<string>();
  private readonly motionKeyframesByItem = new Map<string, readonly MotionKeyframeInput[]>();
  private readonly tracksByName = new Map<string, number>();
  private trackCounter = 0;
  private readonly gainKeyframesByItem = new Map<string, readonly GainKeyframeInput[]>();
  /** Every `transaction()` name run, in order — assertable by tests. */
  readonly transactionLog: { name: string; outcome: "committed" | "rolledBack" }[] = [];
  /** Every `rippleDelete()` call's ranges, in order. */
  readonly rippleDeleteCalls: (readonly FrameRange[])[] = [];
  /** Every `replaceAudioRange()` call, in order. */
  readonly replaceAudioRangeCalls: ReplaceAudioRangeRequest[] = [];

  private nextItemId(prefix: string): string {
    this.itemCounter += 1;
    return `${prefix}-${this.itemCounter}`;
  }

  async importTranscript(request: TranscriptImportRequest): Promise<TranscriptImportResult> {
    const replacedExisting = this.currentTranscriptItemId !== undefined;
    const itemId = this.nextItemId("transcript");
    this.currentTranscriptItemId = itemId;
    this.itemMetadata.set(itemId, {
      aksharo: { projectId: request.sequenceId, rev: 0 },
    });
    return { transcriptItemId: itemId, replacedExisting };
  }

  async insertMogrt(_request: MogrtInsertRequest): Promise<MogrtInsertResult> {
    const itemId = this.nextItemId("mogrt");
    this.mogrtParams.set(itemId, {});
    return { itemId };
  }

  async setMogrtParams(itemId: string, params: MogrtParams): Promise<void> {
    if (!this.mogrtParams.has(itemId)) {
      throw new Error(`setMogrtParams: unknown MOGRT item "${itemId}"`);
    }
    this.mogrtParams.set(itemId, { ...this.mogrtParams.get(itemId), ...params });
  }

  async getMogrtParams(itemId: string): Promise<MogrtParams | undefined> {
    return this.mogrtParams.get(itemId);
  }

  async rippleDelete(ranges: readonly FrameRange[]): Promise<void> {
    this.rippleDeleteCalls.push(ranges);
  }

  async setMotionKeyframes(
    itemId: string,
    keyframes: readonly MotionKeyframeInput[],
  ): Promise<void> {
    this.motionKeyframesByItem.set(itemId, keyframes);
  }

  /** Test helper: the keyframes last passed to `setMotionKeyframes` for `itemId`. */
  getMotionKeyframesFor(itemId: string): readonly MotionKeyframeInput[] | undefined {
    return this.motionKeyframesByItem.get(itemId);
  }

  async importMediaToBin(_request: MediaBinImportRequest): Promise<MediaBinImportResult> {
    const itemId = this.nextItemId("bin");
    this.binItems.add(itemId);
    return { itemId };
  }

  async placeOnTrack(request: PlaceOnTrackRequest): Promise<PlaceOnTrackResult> {
    if (!this.binItems.has(request.itemId)) {
      throw new Error(`placeOnTrack: unknown bin item "${request.itemId}"`);
    }
    const trackItemId = this.nextItemId("track-item");
    return { trackItemId };
  }

  async replaceAudioRange(request: ReplaceAudioRangeRequest): Promise<void> {
    this.replaceAudioRangeCalls.push(request);
  }

  async transaction<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // Deep-clone the mutable state so a thrown error can roll every host mutation made inside
    // `fn` back, mirroring Premiere's `executeTransaction` undo/redo grouping (header citation).
    const snapshot = {
      itemCounter: this.itemCounter,
      currentTranscriptItemId: this.currentTranscriptItemId,
      mogrtParams: new Map(this.mogrtParams),
      itemMetadata: new Map(this.itemMetadata),
      binItems: new Set(this.binItems),
      motionKeyframesByItem: new Map(this.motionKeyframesByItem),
      tracksByName: new Map(this.tracksByName),
      trackCounter: this.trackCounter,
      gainKeyframesByItem: new Map(this.gainKeyframesByItem),
      rippleDeleteCallCount: this.rippleDeleteCalls.length,
      replaceAudioRangeCallCount: this.replaceAudioRangeCalls.length,
    };
    try {
      const result = await fn();
      this.transactionLog.push({ name, outcome: "committed" });
      return result;
    } catch (error) {
      this.itemCounter = snapshot.itemCounter;
      this.currentTranscriptItemId = snapshot.currentTranscriptItemId;
      this.mogrtParams.clear();
      for (const [k, v] of snapshot.mogrtParams) this.mogrtParams.set(k, v);
      this.itemMetadata.clear();
      for (const [k, v] of snapshot.itemMetadata) this.itemMetadata.set(k, v);
      this.binItems.clear();
      for (const v of snapshot.binItems) this.binItems.add(v);
      this.motionKeyframesByItem.clear();
      for (const [k, v] of snapshot.motionKeyframesByItem) this.motionKeyframesByItem.set(k, v);
      this.tracksByName.clear();
      for (const [k, v] of snapshot.tracksByName) this.tracksByName.set(k, v);
      this.trackCounter = snapshot.trackCounter;
      this.gainKeyframesByItem.clear();
      for (const [k, v] of snapshot.gainKeyframesByItem) this.gainKeyframesByItem.set(k, v);
      this.rippleDeleteCalls.length = snapshot.rippleDeleteCallCount;
      this.replaceAudioRangeCalls.length = snapshot.replaceAudioRangeCallCount;
      this.transactionLog.push({ name, outcome: "rolledBack" });
      throw error;
    }
  }

  async setItemMetadata(trackItemId: string, metadata: AksharoItemMetadata): Promise<void> {
    this.itemMetadata.set(trackItemId, metadata);
  }

  async getItemMetadata(trackItemId: string): Promise<AksharoItemMetadata | undefined> {
    return this.itemMetadata.get(trackItemId);
  }

  async listAksharoItems(): Promise<readonly AksharoTrackedItem[]> {
    return [...this.itemMetadata.entries()].map(([trackItemId, metadata]) => ({
      trackItemId,
      metadata,
    }));
  }

  async removeItem(trackItemId: string): Promise<void> {
    this.itemMetadata.delete(trackItemId);
    this.mogrtParams.delete(trackItemId);
    this.binItems.delete(trackItemId);
  }

  async ensureTrack(request: EnsureTrackRequest): Promise<EnsureTrackResult> {
    const key = `${request.kind}:${request.name}`;
    const existing = this.tracksByName.get(key);
    if (existing !== undefined) {
      return { trackIndex: existing, reused: true };
    }
    this.trackCounter += 1;
    this.tracksByName.set(key, this.trackCounter);
    return { trackIndex: this.trackCounter, reused: false };
  }

  async setClipGainKeyframes(
    trackItemId: string,
    keyframes: readonly GainKeyframeInput[],
  ): Promise<void> {
    this.gainKeyframesByItem.set(trackItemId, keyframes);
  }

  /** Test helper: the keyframes last passed to `setClipGainKeyframes` for `trackItemId`. */
  getGainKeyframesFor(trackItemId: string): readonly GainKeyframeInput[] | undefined {
    return this.gainKeyframesByItem.get(trackItemId);
  }

  // --- test helpers (not part of PremiereHost) --------------------------------------------

  /** Simulates the user opening/changing a sequence, selection or in/out in Premiere. */
  emitSequenceChange(event: SequenceChangeEvent): void {
    if (event.sequence !== undefined || event.kind === "sequenceActivated") {
      this.sequence = event.sequence;
    }
    for (const listener of this.listeners) listener(event);
  }

  setSelection(clips: ClipRef[]): void {
    this.selection = clips;
    this.emitSequenceChange({ kind: "selectionChanged", sequence: this.sequence });
  }
}

// ---------------------------------------------------------------------------------------
// Real adapter (runs only inside the UXP panel host; every method below is unverified
// against a live Premiere install — no Premiere Pro, UXP Developer Tool, or A00-03 spike
// result exist on this build host, see the package README). `docs/GATE-C-CHECKLIST.md`
// lists the manual pass each of these calls needs on the first real Premiere run; nothing
// here should be trusted before that checklist is green. Object/method names below follow
// Adobe's public `premierepro` UXP module (Application/Project/Sequence/TrackItem/
// EncoderManager) and `uxp` module (`shell`, `storage`) as documented at the links in this
// file's header comment; several are marked with an inline citation because their exact
// signature is the part the spike must confirm.
// ---------------------------------------------------------------------------------------

/** Lazily `require`s the two UXP-only modules; throws with a clear message outside UXP. */
function requireUxpModules(): { ppro: unknown; uxp: unknown } {
  // `require` is UXP's CommonJS loader for its own built-in modules — not Node's `require`.
  // Using the indirect form keeps bundlers (esbuild) from trying to resolve these at build
  // time, since neither module exists as an npm package.
  const uxpRequire = (globalThis as { require?: (id: string) => unknown }).require;
  if (!uxpRequire) {
    throw new Error("createRealPremiereHost() must run inside the UXP panel host");
  }
  return { ppro: uxpRequire("premierepro"), uxp: uxpRequire("uxp") };
}

/**
 * Real `PremiereHost`. Constructed by `src/index.tsx` only when running inside the UXP panel
 * (never imported by tests — see `premiere.test.ts`, which exercises `MockPremiereHost` only).
 */
export function createRealPremiereHost(): PremiereHost {
  const { ppro, uxp } = requireUxpModules() as {
    ppro: {
      Project: { getActiveProject(): Promise<unknown> };
      Constants?: Record<string, unknown>;
    };
    uxp: { shell: { openExternal(url: string): Promise<void> } };
  };

  // https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/
  async function getActiveSequenceObj(): Promise<unknown> {
    const project = await ppro.Project.getActiveProject();
    if (!project) return undefined;
    // Project.getActiveSequence(): cited at
    // https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/#getactivesequence
    return (project as { getActiveSequence(): Promise<unknown> }).getActiveSequence();
  }

  return {
    async getHostVersion(): Promise<string> {
      // Application.version: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/application/#version
      // GATE-C: confirm this is a property, not a method, on the version actually installed.
      const app = (ppro as unknown as { Application?: { version?: string } }).Application;
      return app?.version ?? "unknown";
    },

    async getActiveSequence(): Promise<SequenceInfo | undefined> {
      const seq = await getActiveSequenceObj();
      if (!seq) return undefined;
      // GATE-C: verify property names (name, frameRate/timebase, frameSizeHorizontal/Vertical,
      // getInPoint/getOutPoint or inPoint/outPoint as ticks vs frames) against a live sequence —
      // see https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/sequence/
      const s = seq as {
        sequenceId?: string;
        name: string;
        frameRate?: { fps: number; ntsc: boolean };
        frameSizeHorizontal?: number;
        frameSizeVertical?: number;
        getInPointAsTime?(): Promise<{ ticks: string } | undefined>;
        getOutPointAsTime?(): Promise<{ ticks: string } | undefined>;
      };
      return {
        sequenceId: s.sequenceId ?? s.name,
        name: s.name,
        frameRate: { fps: s.frameRate?.fps ?? 25, dropFrame: s.frameRate?.ntsc ?? false },
        width: s.frameSizeHorizontal ?? 0,
        height: s.frameSizeVertical ?? 0,
        // GATE-C: ticks -> frame conversion depends on the sequence's exact timebase; do not
        // ship the frame conversion below without verifying it against `Sequence`'s own
        // tick-per-second constant, cited at
        // https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/ticktime/
        inOut: undefined,
      };
    },

    async getSelectedClips(): Promise<ClipRef[]> {
      // Sequence.getSelection(): https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/sequence/#getselection
      // GATE-C: unverified; returning empty until the spike confirms the call shape.
      return [];
    },

    onSequenceChange(): () => void {
      // Application event subscription: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/application/
      // GATE-C: Premiere's UXP event names for sequence/selection changes are unconfirmed;
      // wiring this is the first Gate-C follow-up (see docs/GATE-C-CHECKLIST.md).
      return () => {};
    },

    async requestMixdown(): Promise<MixdownResult> {
      // EncoderManager audio-only export: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/encodermanager/
      // GATE-C: the exact preset/method for a WAV (not AAC) audio-only mixdown is unverified;
      // do not call this in production before the spike confirms it (see package README).
      throw new Error("requestMixdown: unverified against a real Premiere install (Gate C)");
    },

    async openExternalUrl(url: string): Promise<void> {
      // uxp.shell.openExternal: https://developer.adobe.com/premiere-pro/uxp/guides/uxp_guide/uxp-for-scripting/shell/
      await uxp.shell.openExternal(url);
    },

    async readFile(): Promise<Uint8Array> {
      // uxp.storage.localFileSystem: https://developer.adobe.com/premiere-pro/uxp/guides/uxp_guide/uxp-for-scripting/file-system-access/
      throw new Error("readFile: unverified against a real Premiere install (Gate C)");
    },

    async importTranscript(): Promise<TranscriptImportResult> {
      // Transcript.createImportTextSegmentsAction: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/transcript/
      // GATE-C: exact segment/word JSON shape and the "Aksharo-tagged transcript" replace rule
      // (how an existing transcript is identified for idempotent re-import) are unverified.
      throw new Error("importTranscript: unverified against a real Premiere install (Gate C)");
    },

    async insertMogrt(): Promise<MogrtInsertResult> {
      // Project#importMGTItem (MOGRT insert): https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/#importmgtitem
      // GATE-C: confirm the call inserts onto an explicit track index/start, or requires a
      // separate placement step.
      throw new Error("insertMogrt: unverified against a real Premiere install (Gate C)");
    },

    async setMogrtParams(): Promise<void> {
      // ComponentParam#setValue against the MOGRT's "Graphic" component:
      // https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/componentparam/
      // GATE-C: confirm params are addressed by displayName (not just index) and how a group
      // (source-text-style-run-based highlight params) is set.
      throw new Error("setMogrtParams: unverified against a real Premiere install (Gate C)");
    },

    async getMogrtParams(): Promise<MogrtParams | undefined> {
      // ComponentParam#getValue, same reference as setMogrtParams.
      // GATE-C: confirms the start-up self-test's readback path.
      throw new Error("getMogrtParams: unverified against a real Premiere install (Gate C)");
    },

    async rippleDelete(): Promise<void> {
      // TrackItem/Sequence ripple-delete: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/trackitem/
      // GATE-C: confirm the real ripple-delete call (Sequence-level vs. per-TrackItem) and its
      // effect on other tracks' sync (linked audio, other caption tracks).
      throw new Error("rippleDelete: unverified against a real Premiere install (Gate C)");
    },

    async setMotionKeyframes(): Promise<void> {
      // Component "Motion" (scale/position) keyframes: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/component/
      // GATE-C: confirm property names (Scale, Position) and the keyframe API's ease/interpolation
      // enum against MKF2's `Ease`.
      throw new Error("setMotionKeyframes: unverified against a real Premiere install (Gate C)");
    },

    async importMediaToBin(): Promise<MediaBinImportResult> {
      // Project#importFiles: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/
      // GATE-C: confirm the async import completion signal (event vs. resolved promise).
      throw new Error("importMediaToBin: unverified against a real Premiere install (Gate C)");
    },

    async placeOnTrack(): Promise<PlaceOnTrackResult> {
      // Sequence#insertClip / VideoTrack#insertClip, same reference as rippleDelete.
      // GATE-C: confirm overwrite vs. insert semantics and track-item id return shape.
      throw new Error("placeOnTrack: unverified against a real Premiere install (Gate C)");
    },

    async replaceAudioRange(): Promise<void> {
      // AudioTrack mute + insertClip, same references as importMediaToBin/placeOnTrack.
      // GATE-C: confirm "mute a range" is a clip-level gain automation vs. a track-mute toggle
      // (a toggle would mute the whole track, not just `range` — the B10/B10b brief needs the
      // range-scoped behaviour; this may need a silence-gain automation node instead).
      throw new Error("replaceAudioRange: unverified against a real Premiere install (Gate C)");
    },

    async transaction<T>(): Promise<T> {
      // Project#executeTransaction: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/project/#executetransaction
      // GATE-C: confirm rollback-on-throw semantics match this file's mock (an uncaught error
      // inside the transaction callback undoes every action group so far); until then, do not
      // rely on this for anything the panel can't recover from manually.
      throw new Error("transaction: unverified against a real Premiere install (Gate C)");
    },

    async setItemMetadata(): Promise<void> {
      // Marker + Marker#setTypeSpecificData (JSON guid payload): https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/marker/
      // GATE-C: confirm markers support an arbitrary JSON payload vs. string-only, and that a
      // marker attached to a TrackItem (not just a Sequence) is possible for per-item metadata.
      throw new Error("setItemMetadata: unverified against a real Premiere install (Gate C)");
    },

    async getItemMetadata(): Promise<AksharoItemMetadata | undefined> {
      // Marker#getTypeSpecificData, same reference as setItemMetadata.
      throw new Error("getItemMetadata: unverified against a real Premiere install (Gate C)");
    },

    async listAksharoItems(): Promise<readonly AksharoTrackedItem[]> {
      // Sequence#markers iteration, same reference as setItemMetadata.
      throw new Error("listAksharoItems: unverified against a real Premiere install (Gate C)");
    },

    async removeItem(): Promise<void> {
      // TrackItem#remove: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/trackitem/
      throw new Error("removeItem: unverified against a real Premiere install (Gate C)");
    },

    async ensureTrack(): Promise<EnsureTrackResult> {
      // Sequence#addTrack / Sequence.videoTracks/audioTracks + Track#name (D09 sfx/music/title
      // dedicated tracks): https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/sequence/
      // GATE-C: confirm a track-add call exists at all (some UXP builds only expose reading
      // existing tracks, not adding new ones) and, if so, its exact name-matching semantics for
      // this call's idempotent "find by name" contract.
      throw new Error("ensureTrack: unverified against a real Premiere install (Gate C)");
    },

    async setClipGainKeyframes(): Promise<void> {
      // Component "Volume"/"Gain" (Essential Sound or Audio Track Mixer) keyframes, same
      // reference as setMotionKeyframes: https://developer.adobe.com/premiere-pro/uxp/reference/ppro/classes/component/
      // GATE-C: confirm the exact component/property name for a clip's own gain (as opposed to
      // track-level volume) and the keyframe API's unit (dB vs. linear amplitude).
      throw new Error("setClipGainKeyframes: unverified against a real Premiere install (Gate C)");
    },
  };
}

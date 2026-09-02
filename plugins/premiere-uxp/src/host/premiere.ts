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
  };
}

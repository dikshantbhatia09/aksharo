/**
 * The ONLY file in this package allowed to touch CEP/ExtendScript globals (`window.__adobe_cep__`,
 * `CSInterface`, `evalScript`). Everything else — the bridge client, sign-in, the mixdown/upload
 * flow, the layer-spec builder and every UI component — takes an `AeHost` and is fully testable
 * without After Effects or a CEP host installed (brief: "No After Effects exists here").
 *
 * Reference documentation (cited per call; no behaviour here is invented beyond what these pages
 * describe — exact runtime behaviour is unverified until a human runs `docs/GATE-C-CHECKLIST.md`
 * on a real After Effects install):
 *   - CEP 12 HTML Extension Cookbook (panel structure, `CSInterface.evalScript`, manifest):
 *     https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/CEP%2012%20HTML%20Extension%20Cookbook.md
 *   - `CSInterface.js` reference implementation (not vendored in this WP — `createRealAeHost`
 *     below is a Gate-C-gated stub; a real implementation adds `CSInterface.js` per this URL
 *     when it's built against an actual After Effects install):
 *     https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/CSInterface.js
 *   - ExtendScript `app`, `CompItem`, `TextLayer`, `AVLayer` object model:
 *     https://ae-scripting.docsforadobe.dev/general/object.html
 *     https://ae-scripting.docsforadobe.dev/layers/textlayer.html
 *   - `app.beginUndoGroup`/`app.endUndoGroup` (one undo group per apply, brief item 1):
 *     https://ae-scripting.docsforadobe.dev/general/application.html#app-beginundogroup
 *   - Adobe Media Encoder queueing (`app.project.renderQueue`, AME hand-off for WAV mixdown):
 *     https://ae-scripting.docsforadobe.dev/renderqueueitem/renderqueue.html
 *   - `app.project.importFile` (alpha overlay import):
 *     https://ae-scripting.docsforadobe.dev/general/application.html#app-project-importfile
 *   - Layer marker comment (`MarkerValue.comment`, used for the host-id map — no native custom
 *     metadata API on an AE layer the way Premiere has marker `guid`/Resolve has `customData`):
 *     https://ae-scripting.docsforadobe.dev/layers/markervalue.html
 *
 * THREAT-MODEL.md T13 ("Panel secret exposure ... panels hold tokens in memory only; bridge
 * holds credentials") governs `src/auth/session.ts` the same way it governs C05a's Premiere
 * panel: the session lives in a plain in-memory field only, never in `localStorage` or on disk
 * (CEP panels are Chromium 99, per THREAT-MODEL — `window.localStorage` exists and is
 * deliberately not used for this).
 */

/** Frame-accurate work-area range, expressed in composition seconds (AE's own native unit —
 * `CompItem.workAreaStart`/`workAreaDuration` are seconds, not frames, unlike Premiere's
 * integer-frame model). */
export interface CompTimeRange {
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

export interface CompInfo {
  readonly compId: string;
  readonly name: string;
  readonly frameRate: number;
  readonly width: number;
  readonly height: number;
  readonly workArea: CompTimeRange | undefined;
}

/** Mono 16 kHz for cloud transcription (A06/A11); 48 kHz stereo for the "cloud clean" pass —
 * same two formats as `plugins/premiere-uxp/src/host/premiere.ts`'s `MixdownFormat`. */
export type MixdownFormat = "mono16k" | "stereo48k";

export interface MixdownRequest {
  readonly compId: string;
  readonly range: CompTimeRange;
  readonly format: MixdownFormat;
}

export interface MixdownResult {
  /** A local temp-file path; never uploaded directly — `media.stat`/`media.uploadTicket` own that. */
  readonly tempFilePath: string;
  readonly format: MixdownFormat;
  readonly durationMs: number;
}

export type MixdownProgressListener = (progress: { readonly fraction: number }) => void;

/** One styled text layer to add for one segment (brief item 1: `addTextLayers(compId, specs[])`).
 * Position is in comp pixels (top-left origin, AE's own `Layer.transform.position` convention). */
export interface TextLayerSpec {
  readonly segmentId: string;
  readonly text: string;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly colorRgb: readonly [number, number, number];
  readonly positionXPx: number;
  readonly positionYPx: number;
  readonly strokeColorRgb?: readonly [number, number, number];
  readonly strokeWidthPx?: number;
  /** A solid background box behind the text, sized to the rendered text bounds at apply time
   * (real adapter: `TextLayer#sourceRectAtTime`, per the object-model reference above) — only
   * ever set by `src/layers/textLayerSpec.ts` for a style the classification table
   * (`src/styles/ae-style-map.ts`) marked "supported", since a per-word or translucent-glass box
   * is one of the things that downgrades a style to approximate/unsupported (falls back to the
   * alpha overlay instead). */
  readonly box?: {
    readonly fillRgb: readonly [number, number, number];
    readonly opacity: number;
    readonly paddingPx: number;
  };
}

export interface AddTextLayersResult {
  readonly layerIds: readonly string[];
}

export interface ImportOverlayRequest {
  readonly sourcePath: string;
  readonly compId: string;
}

export interface ImportOverlayResult {
  readonly layerId: string;
}

/** Marker-comment payload for the host-id map (brief item 1: `tagLayer(layer, json)` — "marker
 * comment" because AE layers have no native custom-metadata slot the way a Premiere track item
 * marker `guid` or a Resolve clip `customData` table does; a `MarkerValue.comment` JSON string
 * is the closest equivalent, same pattern C08's Resolve script uses for clip `customData`). */
export interface AksharoLayerMetadata {
  readonly aksharo: {
    readonly projectId: string;
    readonly segmentId?: string;
    readonly rev: number;
  };
}

export interface AksharoTrackedLayer {
  readonly layerId: string;
  readonly metadata: AksharoLayerMetadata;
}

/**
 * The seam every CEP/ExtendScript-specific call goes through. `MockAeHost` implements it for
 * tests; a real implementation (`createRealAeHost`, below) calls `CSInterface.evalScript` against
 * the small ES3-subset ExtendScript functions in `src/jsx/aksharo.jsx`, verified manually per
 * `docs/GATE-C-CHECKLIST.md` — no real After Effects exists on this build host.
 */
export interface AeHost {
  /** After Effects' own version string (e.g. "24.0.0"), for the footer version line. */
  getHostVersion(): Promise<string>;

  /** Reads the active composition, or `undefined` when no project/comp is open. Real adapter:
   * `app.project.activeItem` guarded by `instanceof CompItem` (object-model ref above). */
  readComp(): Promise<CompInfo | undefined>;

  /**
   * Requests an AME-queued mixdown of `range` to a temp WAV file. Real adapter: adds the comp to
   * `app.project.renderQueue`, sets an audio-only output module, sends it to AME's watch folder
   * (RenderQueue reference above); the exact output-module/AME hand-off is unverified until Gate C.
   */
  mixdownToWav(
    request: MixdownRequest,
    onProgress?: MixdownProgressListener,
  ): Promise<MixdownResult>;

  /** Opens a URL in the OS default browser (device-code sign-in). ExtendScript
   * `system.callSystem`/CEP shell-open — exact call TBD at Gate C. */
  openExternalUrl(url: string): Promise<void>;

  /** Reads a local file the panel itself produced (the mixdown temp WAV) as bytes, for the
   * presigned upload PUT. Real adapter: CEP's Node integration (`window.cep_node`) or the CEP
   * `fs` API exposed to the panel's own JS context — unverified until Gate C. */
  readFile(path: string): Promise<Uint8Array>;

  /**
   * Adds one styled text layer per segment inside a single `app.beginUndoGroup`/`endUndoGroup`
   * (brief item 1). Real adapter iterates `specs`, creates `CompItem#layers.addText`, sets
   * `sourceText`, position, and Character-panel-equivalent styling (font/size/colour/stroke) via
   * `TextDocument` (object-model ref above) — exact `TextDocument` property names unverified
   * until Gate C.
   */
  addTextLayers(compId: string, specs: readonly TextLayerSpec[]): Promise<AddTextLayersResult>;

  /** Imports a pre-rendered alpha overlay (unsupported/approximate style fallback, A20) and adds
   * it as a layer on `compId`. Real adapter: `app.project.importFile` + `comp.layers.add`. */
  importOverlay(request: ImportOverlayRequest): Promise<ImportOverlayResult>;

  /** Writes the Aksharo host-id map into a layer's marker comment (JSON-stringified). */
  tagLayer(layerId: string, metadata: AksharoLayerMetadata): Promise<void>;

  /** Reads a layer's Aksharo host-id map back from its marker comment, if any. */
  getLayerMetadata(layerId: string): Promise<AksharoLayerMetadata | undefined>;

  /** Lists every layer on the active comp carrying Aksharo marker metadata, for re-sync diffing. */
  listAksharoLayers(): Promise<readonly AksharoTrackedLayer[]>;

  /** Removes a layer (re-sync: a layer whose EDG segment was deleted, or a "replace tagged layers
   * only" re-apply — brief item 2). */
  removeLayer(layerId: string): Promise<void>;

  /**
   * Runs `fn` inside one After Effects undo group (real adapter: `app.beginUndoGroup(name)` /
   * `app.endUndoGroup()`, always paired in a `try/finally` so a thrown error still closes the
   * group — ExtendScript has no automatic transaction rollback the way Premiere's
   * `executeTransaction` does, so a failure mid-`fn` leaves whatever layers were already added;
   * the caller is responsible for any cleanup it wants, same limitation the brief accepts by
   * asking for "one undo group per apply" rather than a full transaction).
   */
  undoGroup<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface MockAeHostOptions {
  readonly hostVersion?: string;
  readonly initialComp?: CompInfo | undefined;
  readonly mixdownResult?: Partial<MixdownResult>;
  readonly mixdownProgressSteps?: readonly number[];
}

const DEFAULT_COMP: CompInfo = {
  compId: "comp-mock-1",
  name: "Mock Comp",
  frameRate: 25,
  width: 1080,
  height: 1920,
  workArea: { startSeconds: 0, durationSeconds: 10 },
};

/**
 * In-memory `AeHost` used by every test in this package and for local panel development — there
 * is no After Effects to attach to on this build host. Deterministic: no timers, no randomness
 * beyond an incrementing counter for ids/temp file names.
 */
export class MockAeHost implements AeHost {
  private hostVersion: string;
  private comp: CompInfo | undefined;
  private readonly mixdownResult: Partial<MixdownResult>;
  private readonly mixdownProgressSteps: readonly number[];
  private mixdownCounter = 0;
  private layerCounter = 0;
  readonly openedUrls: string[] = [];
  private readonly layers = new Map<string, AksharoLayerMetadata | undefined>();
  private readonly fileContents = new Map<string, Uint8Array>();
  private undoGroupDepth = 0;
  readonly undoGroupNames: string[] = [];

  constructor(options: MockAeHostOptions = {}) {
    this.hostVersion = options.hostVersion ?? "24.0.0";
    this.comp = "initialComp" in options ? options.initialComp : DEFAULT_COMP;
    this.mixdownResult = options.mixdownResult ?? {};
    this.mixdownProgressSteps = options.mixdownProgressSteps ?? [0.25, 0.5, 0.75, 1];
  }

  async getHostVersion(): Promise<string> {
    return this.hostVersion;
  }

  async readComp(): Promise<CompInfo | undefined> {
    return this.comp;
  }

  async mixdownToWav(
    request: MixdownRequest,
    onProgress?: MixdownProgressListener,
  ): Promise<MixdownResult> {
    for (const fraction of this.mixdownProgressSteps) {
      onProgress?.({ fraction });
    }
    this.mixdownCounter += 1;
    return {
      tempFilePath: `/tmp/mock-ae-mixdown-${this.mixdownCounter}.wav`,
      format: request.format,
      durationMs: Math.round(request.range.durationSeconds * 1000),
      ...this.mixdownResult,
    };
  }

  async openExternalUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const existing = this.fileContents.get(path);
    if (existing) return existing;
    return new TextEncoder().encode(`mock-audio-bytes:${path}`);
  }

  /** Test helper: pre-seed bytes for a given temp path (e.g. one `mixdownToWav` returned). */
  setFileContents(path: string, bytes: Uint8Array): void {
    this.fileContents.set(path, bytes);
  }

  async addTextLayers(
    _compId: string,
    specs: readonly TextLayerSpec[],
  ): Promise<AddTextLayersResult> {
    if (this.undoGroupDepth === 0) {
      throw new Error("addTextLayers called outside undoGroup()");
    }
    const layerIds: string[] = [];
    for (const _spec of specs) {
      this.layerCounter += 1;
      const layerId = `layer-${this.layerCounter}`;
      this.layers.set(layerId, undefined);
      layerIds.push(layerId);
    }
    return { layerIds };
  }

  async importOverlay(_request: ImportOverlayRequest): Promise<ImportOverlayResult> {
    this.layerCounter += 1;
    const layerId = `layer-${this.layerCounter}`;
    this.layers.set(layerId, undefined);
    return { layerId };
  }

  async tagLayer(layerId: string, metadata: AksharoLayerMetadata): Promise<void> {
    if (!this.layers.has(layerId)) {
      throw new Error(`tagLayer: unknown layer "${layerId}"`);
    }
    this.layers.set(layerId, metadata);
  }

  async getLayerMetadata(layerId: string): Promise<AksharoLayerMetadata | undefined> {
    return this.layers.get(layerId);
  }

  async listAksharoLayers(): Promise<readonly AksharoTrackedLayer[]> {
    const tracked: AksharoTrackedLayer[] = [];
    for (const [layerId, metadata] of this.layers) {
      if (metadata) tracked.push({ layerId, metadata });
    }
    return tracked;
  }

  async removeLayer(layerId: string): Promise<void> {
    this.layers.delete(layerId);
  }

  async undoGroup<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.undoGroupNames.push(name);
    this.undoGroupDepth += 1;
    try {
      return await fn();
    } finally {
      this.undoGroupDepth -= 1;
    }
  }
}

/**
 * Real adapter is intentionally not implemented in this WP beyond a Gate-C-gated stub: every
 * method throws `NOT_IMPLEMENTED_ON_THIS_HOST` until a human runs the checklist against a real
 * After Effects install and swaps in the `CSInterface.evalScript` calls this file's header
 * documents (same pattern `plugins/premiere-uxp/src/host/premiere.ts`'s `createRealPremiereHost`
 * uses for its own unverified calls). Typechecks so the panel's production wiring compiles.
 */
export function createRealAeHost(): AeHost {
  const notImplemented = (method: string) => (): never => {
    throw new Error(
      `AeHost.${method}: not implemented — no After Effects install exists on this build host. ` +
        "See docs/GATE-C-CHECKLIST.md before calling this on a real host.",
    );
  };
  return {
    getHostVersion: notImplemented("getHostVersion"),
    readComp: notImplemented("readComp"),
    mixdownToWav: notImplemented("mixdownToWav"),
    openExternalUrl: notImplemented("openExternalUrl"),
    readFile: notImplemented("readFile"),
    addTextLayers: notImplemented("addTextLayers"),
    importOverlay: notImplemented("importOverlay"),
    tagLayer: notImplemented("tagLayer"),
    getLayerMetadata: notImplemented("getLayerMetadata"),
    listAksharoLayers: notImplemented("listAksharoLayers"),
    removeLayer: notImplemented("removeLayer"),
    undoGroup: notImplemented("undoGroup"),
  };
}

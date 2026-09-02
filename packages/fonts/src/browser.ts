/**
 * The browser `FontRegistry` loader.
 *
 * The editor and the browser exporter draw with CanvasKit, which — like
 * HarfBuzz — reads **sfnt** tables and does not read WOFF2. So "load a WOFF2
 * into the registry" means decompress it first, and this module is where that
 * happens:
 *
 * ```
 * GET /fonts/manifest  ->  fetch each face's .woff2  ->  decompress to sfnt
 *                      ->  FontRegistry.register     ->  CanvasKit typeface
 * ```
 *
 * WOFF2 is worth the decompression step: a Devanagari subset is 180 kB as sfnt
 * and 60 kB as WOFF2, and a Hinglish project loads four or five faces before it
 * can draw its first caption.
 *
 * The decompressor is **injected** rather than imported. `woff2-encoder` is an
 * ESM-only wasm module and this package builds to CommonJS as well, so a static
 * import would make the CJS build unloadable; passing it in also lets a host
 * that already has one (or that would rather ship sfnt and skip the wasm
 * entirely) decide. {@link defaultWoff2Decompressor} is the convenience path and
 * {@link loadFontsInBrowser} falls back to the manifest's `.ttf` when there is
 * no decompressor at all.
 */

import { createFontRegistry, type FontRegistry, type FontResource } from "@montaj/render-core";

import { parseManifest, type FontFace, type FontManifest } from "./manifest.js";

/** WOFF2 bytes in, sfnt bytes out. */
export type Woff2Decompressor = (bytes: Uint8Array) => Promise<Uint8Array>;

/** Just enough of `fetch` to be faked in a unit test. */
export type FetchLike = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

export class FontLoadError extends Error {
  public override readonly name = "FontLoadError";
  constructor(
    readonly code: "fonts/manifest_unreachable" | "fonts/face_unreachable" | "fonts/no_decoder",
    message: string,
  ) {
    super(message);
  }
}

export interface LoadFontsOptions {
  /** Where `GET /fonts/manifest` lives. Ignored when `manifest` is given. */
  readonly manifestUrl?: string;
  /** An already-fetched manifest, when the host has one (the editor does). */
  readonly manifest?: unknown;
  /**
   * Resolve a face to the URL its bytes are at. The default uses the manifest's
   * own `woff2Url`/`url`, which is what the API fills in with signed URLs.
   */
  readonly resolveUrl?: (face: FontFace, format: "woff2" | "sfnt") => string | undefined;
  /** Which format to prefer. `woff2` needs a decompressor; `sfnt` does not. */
  readonly prefer?: "woff2" | "sfnt";
  readonly decompressWoff2?: Woff2Decompressor;
  readonly fetch?: FetchLike;
  /** Register into this registry instead of a new one. */
  readonly registry?: FontRegistry;
  /** Only these families, when a project needs three faces and not forty. */
  readonly families?: readonly string[];
  readonly onWarning?: (message: string) => void;
}

export interface LoadedBrowserFonts {
  readonly registry: FontRegistry;
  readonly fonts: readonly FontResource[];
  readonly manifest: FontManifest;
  /** Faces the loader could not fetch or decode, with the reason. */
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
  /** How many faces arrived as WOFF2 and how many as sfnt. */
  readonly counts: { readonly woff2: number; readonly sfnt: number };
}

const defaultFetch: FetchLike = (url) => globalThis.fetch(url) as ReturnType<FetchLike>;

/** The manifest's own URLs: `woff2Url`/`url`, else the bare file names. */
export function manifestUrlFor(face: FontFace, format: "woff2" | "sfnt"): string | undefined {
  if (format === "woff2") return face.woff2Url ?? face.woff2;
  return face.url ?? face.file;
}

/**
 * `woff2-encoder/decompress`, loaded on demand.
 *
 * A **dynamic** import, because `woff2-encoder` is ESM-only and this package
 * also builds to CommonJS: under `module: nodenext` TypeScript leaves `import()`
 * alone in a CJS file rather than rewriting it to `require`, which is exactly
 * how a CommonJS module is allowed to load an ES one. It is loaded on demand so
 * a host that never draws a WOFF2 never pays for the 300 kB of wasm.
 */
export async function defaultWoff2Decompressor(): Promise<Woff2Decompressor> {
  const loaded = (await import("woff2-encoder/decompress")) as unknown as {
    readonly default?: Woff2Decompressor;
    readonly decompress?: Woff2Decompressor;
  };
  const decompress = loaded.default ?? loaded.decompress;
  if (typeof decompress !== "function") {
    throw new FontLoadError(
      "fonts/no_decoder",
      "woff2-encoder/decompress did not export a decompress function",
    );
  }
  return decompress;
}

/**
 * Fetch a manifest and register every face it names into a `FontRegistry`.
 *
 * A face that cannot be fetched is reported in `failed` rather than thrown: a
 * project with one unreachable custom font should still draw its other thirty
 * captions, and `FontRegistry` already answers a missing family by falling back
 * to something that covers the code points.
 */
export async function loadFontsInBrowser(
  options: LoadFontsOptions = {},
): Promise<LoadedBrowserFonts> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const manifest = await resolveManifest(options, fetchImpl);
  const registry = options.registry ?? createFontRegistry();
  const resolveUrl = options.resolveUrl ?? manifestUrlFor;
  const prefer = options.prefer ?? "woff2";

  const wanted =
    options.families === undefined
      ? manifest.fonts
      : manifest.fonts.filter((face) =>
          options.families?.some((family) => sameFamily(family, face.family)),
        );

  const fonts: FontResource[] = [];
  const failed: { id: string; reason: string }[] = [];
  let woff2Count = 0;
  let sfntCount = 0;

  for (const face of wanted) {
    try {
      const loaded = await loadFace(face, {
        fetchImpl,
        resolveUrl,
        prefer,
        ...(options.decompressWoff2 === undefined
          ? {}
          : { decompressWoff2: options.decompressWoff2 }),
      });
      if (loaded.format === "woff2") woff2Count += 1;
      else sfntCount += 1;
      const resource: FontResource = {
        id: face.id,
        family: face.family,
        weight: face.weight,
        italic: face.italic,
        data: loaded.data,
        scripts: face.scripts,
      };
      registry.register(resource);
      fonts.push(resource);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ id: face.id, reason });
      options.onWarning?.(`could not load ${face.family} (${face.id}): ${reason}`);
    }
  }

  return {
    registry,
    fonts,
    manifest,
    failed,
    counts: { woff2: woff2Count, sfnt: sfntCount },
  };
}

async function resolveManifest(
  options: LoadFontsOptions,
  fetchImpl: FetchLike,
): Promise<FontManifest> {
  if (options.manifest !== undefined) return parseManifest(options.manifest, "the given manifest");
  if (options.manifestUrl === undefined) {
    throw new FontLoadError(
      "fonts/manifest_unreachable",
      "pass either a manifest or the URL of one",
    );
  }
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(options.manifestUrl);
  } catch (error) {
    throw new FontLoadError(
      "fonts/manifest_unreachable",
      `${options.manifestUrl} could not be fetched: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new FontLoadError(
      "fonts/manifest_unreachable",
      `${options.manifestUrl} answered ${String(response.status)}`,
    );
  }
  return parseManifest(await response.json(), options.manifestUrl);
}

interface LoadFaceContext {
  readonly fetchImpl: FetchLike;
  readonly resolveUrl: (face: FontFace, format: "woff2" | "sfnt") => string | undefined;
  readonly prefer: "woff2" | "sfnt";
  readonly decompressWoff2?: Woff2Decompressor;
}

/** One face's bytes, as sfnt, whichever format they arrived in. */
export async function loadFace(
  face: FontFace,
  context: LoadFaceContext,
): Promise<{ readonly data: Uint8Array; readonly format: "woff2" | "sfnt" }> {
  // Without a decompressor the WOFF2 is unreadable, so it is not tried at all —
  // trying and failing would replace a useful "404" with "no decompressor".
  const order: readonly ("woff2" | "sfnt")[] =
    context.decompressWoff2 === undefined
      ? ["sfnt"]
      : context.prefer === "woff2"
        ? ["woff2", "sfnt"]
        : ["sfnt", "woff2"];

  let lastReason =
    context.decompressWoff2 === undefined
      ? "no sfnt URL, and WOFF2 needs a decompressor this host did not supply"
      : "no URL for either format";
  for (const format of order) {
    const url = context.resolveUrl(face, format);
    if (url === undefined || url === "") continue;
    try {
      const response = await context.fetchImpl(url);
      if (!response.ok) {
        lastReason = `${url} answered ${String(response.status)}`;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (format === "sfnt") return { data: bytes, format };
      const decompress = context.decompressWoff2;
      if (decompress === undefined) continue;
      return { data: await decompress(bytes), format };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  throw new FontLoadError("fonts/face_unreachable", lastReason);
}

function sameFamily(a: string, b: string): boolean {
  return (
    a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ")
  );
}

/** The two DOM bits `installCssFontFaces` needs, declared rather than imported. */
export interface CssFontFace {
  load(): Promise<unknown>;
}

export interface CssFontFaceSink {
  add(face: CssFontFace): void;
}

/** `new FontFace(family, source, descriptors)`, injectable for tests. */
export type CssFontFaceFactory = (
  family: string,
  source: string,
  descriptors: { readonly weight: string; readonly style: string },
) => CssFontFace;

interface GlobalWithFontFace {
  readonly FontFace?: new (
    family: string,
    source: string,
    descriptors: { weight: string; style: string },
  ) => CssFontFace;
  readonly document?: { readonly fonts?: CssFontFaceSink };
}

/**
 * Install a manifest's faces as CSS `@font-face`s, for DOM text.
 *
 * Nothing in the render path needs this — captions are drawn from
 * `DrawCommand[]`, never from DOM text — but the font picker previews family
 * names in the browser's own typography, and a `FontFace` built from the WOFF2
 * is the cheapest honest way to show one. Returns the families it installed;
 * an empty array outside a browser.
 */
export async function installCssFontFaces(
  manifest: FontManifest,
  options: {
    readonly resolveUrl?: (face: FontFace, format: "woff2" | "sfnt") => string | undefined;
    readonly sink?: CssFontFaceSink;
    readonly createFontFace?: CssFontFaceFactory;
    readonly onWarning?: (message: string) => void;
  } = {},
): Promise<string[]> {
  const host = globalThis as unknown as GlobalWithFontFace;
  const sink = options.sink ?? host.document?.fonts;
  const FontFaceCtor = host.FontFace;
  const createFontFace: CssFontFaceFactory | undefined =
    options.createFontFace ??
    (FontFaceCtor === undefined
      ? undefined
      : (family, source, descriptors) => new FontFaceCtor(family, source, { ...descriptors }));
  if (sink === undefined || createFontFace === undefined) return [];

  const resolveUrl = options.resolveUrl ?? manifestUrlFor;
  const installed: string[] = [];
  for (const face of manifest.fonts) {
    const url = resolveUrl(face, "woff2") ?? resolveUrl(face, "sfnt");
    if (url === undefined || url === "") continue;
    try {
      const cssFace = createFontFace(face.family, `url(${url})`, {
        weight: String(face.weight),
        style: face.italic ? "italic" : "normal",
      });
      await cssFace.load();
      sink.add(cssFace);
      installed.push(face.family);
    } catch (error) {
      options.onWarning?.(
        `could not install ${face.family} as a CSS face: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return installed;
}

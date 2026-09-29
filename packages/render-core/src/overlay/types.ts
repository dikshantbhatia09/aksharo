/**
 * Overlays as the projection hands them over (`EdgHot.overlays`): things drawn
 * over the video that are not captions, on the source clock like a segment.
 *
 * - the hook title (2026-09-29), a card over a clip's first seconds;
 * - a brand logo in a corner, and an end card over its last seconds (the brand
 *   kit, 2026-10-02).
 *
 * These mirror `@montaj/edg`'s `OverlaySchema` field for field; they are
 * restated here, readonly and structural, because the renderer runs in places
 * that were handed a projection, not a document.
 */

/** The hook title's kind (`@montaj/edg` `OverlayKind`). */
export const HOOK_TITLE_KIND = "hook-title";
/** A brand logo in a corner (2026-10-02). */
export const LOGO_KIND = "logo";
/** A brand end card over the last seconds (2026-10-02). */
export const END_CARD_KIND = "end-card";

/**
 * An image an overlay draws: a workspace's uploaded logo. `assetId` is the key
 * an `image` command names and the host resolves to bytes; `width`/`height` are
 * the file's own pixel size, so it can be sized without decoding it.
 */
export interface OverlayImageRef {
  readonly assetId: string;
  readonly format?: string;
  readonly width: number;
  readonly height: number;
}

export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** A brand kit's hook-title look; an absent field is the document style's own. */
export interface HookTitleAppearance {
  readonly fontFamily?: string;
  /** The card's colour. */
  readonly background?: string;
  /** The words' colour. */
  readonly text?: string;
}

export interface HookTitleTrack {
  readonly id: string;
  readonly kind: typeof HOOK_TITLE_KIND;
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly appearance?: HookTitleAppearance;
}

export interface LogoTrack {
  readonly id: string;
  readonly kind: typeof LOGO_KIND;
  readonly startMs: number;
  readonly endMs: number;
  readonly image: OverlayImageRef;
  readonly corner: OverlayCorner;
  /** Width as a share (percent) of the frame's width. */
  readonly sizePct: number;
  readonly opacity: number;
  /** Distance from the edges as a share (percent) of the frame's short side. */
  readonly marginPct: number;
}

export interface EndCardTrack {
  readonly id: string;
  readonly kind: typeof END_CARD_KIND;
  readonly startMs: number;
  readonly endMs: number;
  readonly cta?: string;
  readonly handle?: string;
  /** What the frame dims to. */
  readonly background: string;
  readonly text?: string;
  readonly accent?: string;
  readonly fontFamily?: string;
  readonly image?: OverlayImageRef;
}

/** Any overlay, told apart by `kind`. */
export type OverlayTrack = HookTitleTrack | LogoTrack | EndCardTrack;

/**
 * Every image the overlays draw (a brand logo, in a corner or on an end card),
 * once each: what a host fetches and registers with its backend before
 * drawing, so an `image` command finds its bytes.
 */
export function overlayImageIds(overlays: readonly OverlayTrack[] | undefined): string[] {
  const ids = new Set<string>();
  for (const overlay of overlays ?? []) {
    if (overlay.kind === LOGO_KIND) ids.add(overlay.image.assetId);
    if (overlay.kind === END_CARD_KIND && overlay.image !== undefined) {
      ids.add(overlay.image.assetId);
    }
  }
  return [...ids];
}

/** Whether an overlay is on screen at `sourceMs`: its window is start-inclusive, end-exclusive. */
export function overlayActiveAt(overlay: OverlayTrack, sourceMs: number): boolean {
  return sourceMs >= overlay.startMs && sourceMs < overlay.endMs;
}

/**
 * Layouts worked out once per document, not thirty times a second. Keyed by the
 * projection (or whatever object stands for "this document at this revision"),
 * so an edit — a new projection object — lays everything out afresh, and a
 * render's one projection is laid out once for the whole video.
 */
export class OverlayLayoutCache<T> {
  readonly #byOwner = new WeakMap<object, Map<string, T | null>>();

  get(owner: object, key: string, compute: () => T | undefined): T | undefined {
    let entries = this.#byOwner.get(owner);
    if (entries === undefined) {
      entries = new Map();
      this.#byOwner.set(owner, entries);
    }
    const cached = entries.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const value = compute();
    entries.set(key, value ?? null);
    return value;
  }
}

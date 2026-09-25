/**
 * The video lane's filmstrip: frame-shaped tiles, not stretched slices.
 *
 * worker-media makes 10-32 thumbnails per video (`thumbnailCount`: one per half
 * second, bounded)
 * (`apps/worker-media/src/ffmpeg/derive.ts`, midpoints of equal slices). The
 * lane used to stretch each one across a full `1/count` of the timeline, so a
 * 9:16 frame drawn into a slice ~5:1 came out about nine times too wide
 * (2026-09-25). A professional filmstrip instead repeats tiles at the video's
 * own aspect ratio along the lane and shows the nearest frame in each, so a
 * frame is never distorted however far the timeline is zoomed.
 *
 * Tiles are anchored to **time** (tile `k` covers `[k·tileMs, (k+1)·tileMs)`),
 * not to the screen, so they scroll with the media instead of shimmering, and
 * only the ones inside the visible range are produced.
 */
import type { Viewport } from "./coords";

/** Narrowest tile, CSS px — a very tall video still reads as frames, not slivers. */
export const MIN_TILE_WIDTH_PX = 18;

export interface FilmstripTile {
  /** Left edge, CSS px in the canvas. */
  readonly x: number;
  /** Width, CSS px — the last tile is cut short at the media's end. */
  readonly w: number;
  /** Which thumbnail to show: the one whose slice holds the tile's centre. */
  readonly thumbIndex: number;
}

export function filmstripTiles(input: {
  readonly durationMs: number;
  readonly thumbCount: number;
  /** Frame width / height (e.g. 9/16 for vertical video). */
  readonly aspect: number;
  /** The height a tile is drawn at, CSS px. */
  readonly tileHeightPx: number;
  readonly viewport: Viewport;
  /** The visible time range (already padded by the caller). */
  readonly startMs: number;
  readonly endMs: number;
}): FilmstripTile[] {
  const { durationMs, thumbCount, viewport } = input;
  if (durationMs <= 0 || thumbCount <= 0 || viewport.msPerPx <= 0) return [];
  const aspect = Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 16 / 9;
  const tileWidthPx = Math.max(MIN_TILE_WIDTH_PX, input.tileHeightPx * aspect);
  const tileMs = tileWidthPx * viewport.msPerPx;

  const first = Math.max(0, Math.floor(input.startMs / tileMs));
  const lastMs = Math.min(input.endMs, durationMs);
  const tiles: FilmstripTile[] = [];
  for (let k = first; k * tileMs < lastMs; k += 1) {
    const sMs = k * tileMs;
    const eMs = Math.min((k + 1) * tileMs, durationMs);
    const centreMs = (sMs + eMs) / 2;
    const thumbIndex = Math.min(thumbCount - 1, Math.floor((centreMs / durationMs) * thumbCount));
    const x = (sMs - viewport.scrollMs) / viewport.msPerPx;
    tiles.push({ x, w: (eMs - sMs) / viewport.msPerPx, thumbIndex });
  }
  return tiles;
}

/**
 * The source rectangle that fills `dw × dh` without distortion ("cover"):
 * scale to the larger ratio, then take the centred window of the image.
 */
export function coverCrop(
  image: { readonly width: number; readonly height: number },
  dw: number,
  dh: number,
): { readonly sx: number; readonly sy: number; readonly sw: number; readonly sh: number } {
  const scale = Math.max(dw / image.width, dh / image.height);
  const sw = Math.min(image.width, dw / scale);
  const sh = Math.min(image.height, dh / scale);
  return { sx: (image.width - sw) / 2, sy: (image.height - sh) / 2, sw, sh };
}

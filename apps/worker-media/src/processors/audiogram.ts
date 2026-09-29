/**
 * An audiogram (2026-10-04): the picture a clip gets when its source has none.
 *
 * An audio-only source - a podcast, a voice note, the bundled sample - used to
 * be cut into clips with no video stream at all, and everything after the cut
 * needed one: the cloud render refuses a source without a picture
 * (`render/no-video-stream`), the image formats are frames of a video, a
 * compilation joins pictures, and the editor could only say "audio only". Now
 * `media.clip` draws a picture instead, at the shape's own size:
 *
 * - **the ground**, one flat colour (`background`: the brand kit's secondary
 *   colour, or a calm dark default);
 * - **the artwork**, fitted into a square above where captions go (a cover the
 *   person gave with the run, else the kit's logo, else none);
 * - **a live waveform** of the clip's own audio (`showwaves`), in `accent`,
 *   under the artwork - or on its own, larger, when there is none.
 *
 * Everything sits in {@link PICTURE_BAND}, above {@link CAPTION_BAND}: the
 * default caption style (Punch Pop) sets its bottom line at 72 % of the height
 * with two lines above it, and Karaoke Fill at 76 %, so nothing drawn here is
 * under a caption the render puts on later. There are no faces for captions
 * to move off, so they stay where their style puts them.
 *
 * Numbers are computed here rather than as filter expressions, for the reason
 * `clip-frame.ts` gives: an expression's commas have to survive two parsers,
 * and a mistake fails at runtime on exactly the size nobody tried.
 */

import { CLIP_ASPECTS, MAX_CLIP_HEIGHT, type ClipAspect } from "./clip-frame.js";
import { FFMPEG_BASE_ARGS, inputArgs } from "../ffmpeg/run.js";

/** What the payload's `audiogram` asks for (`AudiogramSchema` in the contract). */
export interface AudiogramRequest {
  /** `#RRGGBB`. */
  readonly background: string;
  /** `#RRGGBB`: the waveform's colour. */
  readonly accent: string;
  /** An image in the derived store, in the clip's own workspace. */
  readonly artwork?: { readonly key: string; readonly format: AudiogramArtworkFormat };
}

export const AUDIOGRAM_ARTWORK_FORMATS = ["png", "jpeg", "webp"] as const;
export type AudiogramArtworkFormat = (typeof AUDIOGRAM_ARTWORK_FORMATS)[number];

/** The only colours a filtergraph is given: `#RRGGBB`, nothing a parser could read as more. */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

export function isHexColour(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOUR.test(value);
}

/** Frames a second: the rate every clip project's canvas plays at. */
export const AUDIOGRAM_FPS = 30;

/**
 * Where captions go, as fractions of the height, kept clear: Punch Pop's two
 * lines end at 72 %, Karaoke Fill's three at 76 %; a caption that starts at
 * the middle of the frame (Hype Bold, Word Pop) is covered from 50 %.
 */
export const CAPTION_BAND = { top: 0.5, bottom: 0.78 } as const;

/** Where the artwork and the waveform go: above the captions, clear of the top edge. */
export const PICTURE_BAND = { top: 0.06, bottom: 0.47 } as const;

/** The largest share of the width anything here takes. */
const MAX_WIDTH_SHARE = 0.84;
/** The artwork's side, at most: this share of the band's height, and of the width. */
const ARTWORK_BAND_SHARE = 0.68;
const ARTWORK_WIDTH_SHARE = 0.78;
/** The gap between the artwork and the waveform, as a share of the band. */
const GAP_BAND_SHARE = 0.04;
/** The waveform's height under artwork, and on its own, as shares of the band. */
const WAVE_UNDER_ART_SHARE = 0.24;
const WAVE_ALONE_SHARE = 0.5;
/** How wide a waveform is at most, for its band's height: a wide frame is not one long line. */
const WAVE_WIDTH_UNDER_ART = 1.6;
const WAVE_WIDTH_ALONE = 2.2;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AudiogramLayout {
  readonly width: number;
  readonly height: number;
  /** The square the artwork is fitted into (keeping its own shape); `null` without artwork. */
  readonly artwork: Box | null;
  readonly waveform: Box;
}

/**
 * The picture's size for a cut in `aspect` at most `maxHeight` tall: the
 * shape's own canvas (1080 x 1920 for 9:16, 1920 x 1080 for 16:9, ...). Unlike
 * a cut of a video there is no source picture to stay under, so it is always
 * the full size the payload allows.
 */
export function audiogramSize(
  aspect: ClipAspect = "9:16",
  maxHeight: number = MAX_CLIP_HEIGHT,
): { readonly width: number; readonly height: number } {
  // eslint-disable-next-line security/detect-object-injection -- a closed enum (ClipAspect), not input
  const shape = CLIP_ASPECTS[aspect];
  const height = floorEven(
    Math.min(Number.isFinite(maxHeight) ? maxHeight : MAX_CLIP_HEIGHT, MAX_CLIP_HEIGHT),
  );
  return { width: even((height * shape.width) / shape.height), height };
}

/**
 * Where the artwork and the waveform go in a `width` x `height` picture.
 *
 * With artwork: a square as large as the band allows ({@link ARTWORK_BAND_SHARE}
 * of it, never wider than {@link ARTWORK_WIDTH_SHARE} of the frame), centred,
 * and the waveform under it; the two are centred in the band together. Without:
 * the waveform alone, half the band tall, in its middle.
 */
export function audiogramLayout(
  size: { readonly width: number; readonly height: number },
  options: { readonly artwork: boolean },
): AudiogramLayout {
  const { width, height } = size;
  const bandTop = Math.round(height * PICTURE_BAND.top);
  const band = Math.round(height * PICTURE_BAND.bottom) - bandTop;
  const centred = (boxWidth: number): number => evenOffset((width - boxWidth) / 2);

  if (!options.artwork) {
    const waveHeight = floorEven(band * WAVE_ALONE_SHARE);
    const waveWidth = floorEven(Math.min(width * MAX_WIDTH_SHARE, band * WAVE_WIDTH_ALONE));
    return {
      width,
      height,
      artwork: null,
      waveform: {
        x: centred(waveWidth),
        y: bandTop + evenOffset((band - waveHeight) / 2),
        width: waveWidth,
        height: waveHeight,
      },
    };
  }

  const side = floorEven(Math.min(width * ARTWORK_WIDTH_SHARE, band * ARTWORK_BAND_SHARE));
  const gap = Math.round(band * GAP_BAND_SHARE);
  const waveHeight = floorEven(Math.min(band - side - gap, band * WAVE_UNDER_ART_SHARE));
  const waveWidth = floorEven(Math.min(width * MAX_WIDTH_SHARE, band * WAVE_WIDTH_UNDER_ART));
  const top = bandTop + evenOffset((band - (side + gap + waveHeight)) / 2);
  return {
    width,
    height,
    artwork: { x: centred(side), y: top, width: side, height: side },
    waveform: { x: centred(waveWidth), y: top + side + gap, width: waveWidth, height: waveHeight },
  };
}

/** `#RRGGBB` as ffmpeg's `0xRRGGBB`. Refuses anything else, rather than pass it to a parser. */
export function ffmpegColour(hex: string): string {
  if (!isHexColour(hex)) throw new Error(`not a #RRGGBB colour: ${JSON.stringify(hex)}`);
  return `0x${hex.slice(1).toLowerCase()}`;
}

/**
 * The filtergraph: input 0 is the clip's audio, input 1 (when `artwork`) the
 * artwork image. Its outputs are `[v]`, the picture, and `[a]`, the audio to
 * encode. The ground is an endless `color` source; the artwork is one decoded
 * frame the overlay repeats (`eof_action=repeat`); the waveform is what sets
 * the picture's length (`shortest=1`), so the video ends with the audio.
 *
 * `yuv420p` at the end, as for any cut: the run page plays the mezzanine
 * itself, and a browser cannot play anything else.
 */
export function audiogramFilter(
  layout: AudiogramLayout,
  request: Pick<AudiogramRequest, "background" | "accent">,
  options: { readonly artwork: boolean },
): string {
  const { width, height, waveform } = layout;
  const art = options.artwork ? layout.artwork : null;
  const n = String;
  const chains = [
    `color=c=${ffmpegColour(request.background)}:s=${n(width)}x${n(height)}:r=${n(AUDIOGRAM_FPS)}[ground]`,
    "[0:a]asplit=2[wavein][a]",
    // One channel: a stereo waveform would draw its two channels over each other.
    `[wavein]aformat=channel_layouts=mono,showwaves=s=${n(waveform.width)}x${n(waveform.height)}` +
      `:mode=cline:rate=${n(AUDIOGRAM_FPS)}:colors=${ffmpegColour(request.accent)}` +
      ":scale=sqrt:draw=full,format=rgba[wave]",
  ];
  let picture = "[ground]";
  if (art !== null) {
    chains.push(
      `[1:v]scale=${n(art.width)}:${n(art.height)}:force_original_aspect_ratio=decrease,` +
        "setsar=1,format=rgba[art]",
      // Centred in its square whatever its own shape: `w` and `h` are the
      // scaled artwork's, and the expressions have no commas to escape.
      `[ground][art]overlay=x=${n(art.x)}+(${n(art.width)}-w)/2:y=${n(art.y)}+(${n(art.height)}-h)/2` +
        ":eof_action=repeat[pictured]",
    );
    picture = "[pictured]";
  }
  chains.push(
    `${picture}[wave]overlay=x=${n(waveform.x)}:y=${n(waveform.y)}:shortest=1,` +
      "setsar=1,format=yuv420p[v]",
  );
  return chains.join(";");
}

export interface AudiogramArgsInput {
  readonly sourceUrl: string;
  /** A readable image (a signed URL or a local path), or undefined for none. */
  readonly artworkUrl?: string;
  readonly startSec: string;
  readonly durationSec: string;
  readonly layout: AudiogramLayout;
  readonly request: Pick<AudiogramRequest, "background" | "accent">;
  readonly outPath: string;
}

/**
 * The whole ffmpeg command for an audiogram cut: the audio read from the
 * source with an input seek and an input length (so the read stops where the
 * clip does), the artwork read once, and one H.264 + AAC MP4 written with its
 * index up front - the same codecs and quality as a cut of a video.
 */
export function audiogramArgs(input: AudiogramArgsInput): string[] {
  const artwork = input.artworkUrl !== undefined;
  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    "-nostats",
    "-ss",
    input.startSec,
    "-t",
    input.durationSec,
    ...inputArgs(input.sourceUrl),
    ...(artwork ? inputArgs(input.artworkUrl ?? "") : []),
    "-filter_complex",
    audiogramFilter(input.layout, input.request, { artwork }),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-t",
    input.durationSec,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-r",
    String(AUDIOGRAM_FPS),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-sn",
    "-dn",
    "-movflags",
    "+faststart",
    input.outPath,
  ];
}

/** Round to an even number ≥ 2: H.264 4:2:0 cannot encode odd dimensions. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/** The largest even number ≤ `value` (and ≥ 2): a size. */
function floorEven(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/** The largest even number ≤ `value` (and ≥ 0): a position, on a chroma sample. */
function evenOffset(value: number): number {
  return Math.max(0, Math.floor(value / 2) * 2);
}

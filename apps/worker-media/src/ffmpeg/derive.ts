import { transientFailure, unreadableMedia } from "../errors.js";
import { FFMPEG_BASE_ARGS, inputArgs, run } from "./run.js";

/**
 * The four ffmpeg graphs that make a derived object, and the numbers in them.
 *
 * Every constant here is a product decision written down once:
 *
 * | Output          | Why it is what it is                                        |
 * | --------------- | ----------------------------------------------------------- |
 * | `audio16k.wav`  | Whisper and every wav2vec aligner want 16 kHz mono PCM. Any  |
 * |                 | other rate is resampled inside the model anyway, worse.      |
 * | `audio48k.wav`  | The mastering rate. `09 §5` cleans and re-times at 48 kHz,   |
 * |                 | and downsampling to 16 k first would throw away what clean   |
 * |                 | is for.                                                     |
 * | `proxy540.mp4`  | The editor scrubs this, not the original: 540p at CRF 28 is  |
 * |                 | a tenth of the bytes and indistinguishable at editor size.   |
 * |                 | `+faststart` puts the moov atom first so a browser can play  |
 * |                 | before the file has finished downloading.                    |
 * | `thumb-{n}.jpg` | Ten frames at 320 px wide: a filmstrip, not a gallery.       |
 *
 * The **input seek** (`-ss` before `-i`) is the reason ten thumbnails are cheap.
 * After `-i` it decodes from the start of the file to the timestamp; before it,
 * ffmpeg jumps to the nearest keyframe and issues one range request. On a
 * sixty-minute source that is the difference between ten seconds and ten minutes.
 */

/** Sample rate of the ASR audio (`audio16k.wav`). */
export const ASR_SAMPLE_RATE = 16_000;

/** Sample rate of the mastering audio (`audio48k.wav`). */
export const MASTER_SAMPLE_RATE = 48_000;

/**
 * Both WAVs are mono.
 *
 * ASR and forced alignment are mono models, and `09 §5`'s clean chain works on a
 * mono bed. A stereo 48 kHz track would double the bytes for a channel nothing
 * downstream reads separately.
 */
export const AUDIO_CHANNELS = 1;

/** The proxy's short side, in pixels — "540p" for landscape and portrait alike. */
export const PROXY_SHORT_SIDE = 540;

/** Constant Rate Factor for the proxy. 28 is visually fine at editor size. */
export const PROXY_CRF = 28;

/** Proxy audio bitrate. Speech at 96 kbit/s AAC is transparent enough to cut on. */
export const PROXY_AUDIO_BITRATE = "96k";

/** How many thumbnails a video gets. */
export const THUMBNAIL_COUNT = 10;

/** Thumbnail width in pixels; the height follows the aspect ratio. */
export const THUMBNAIL_WIDTH = 320;

/** JPEG quality for thumbnails: 2 is best, 31 worst. */
export const THUMBNAIL_QUALITY = 4;

export interface DeriveContext {
  readonly binary: string;
  readonly source: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * Extract one mono PCM WAV at `sampleRate`.
 *
 * `-map 0:a:0` rather than letting ffmpeg choose: a container with a commentary
 * track would otherwise get whichever stream ffmpeg thought was "best", and the
 * transcript would be of the wrong one.
 */
/** Speech enhancement filter applied to ASR audio (`audio16k.wav`) for noise suppression and voice clarity. */
export const ASR_AUDIO_FILTER =
  "highpass=f=80,lowpass=f=8500,afftdn=nf=-25:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11";

export function audioArgs(
  sampleRate: number,
  source: string,
  out: string,
  options?: { clean?: boolean },
): string[] {
  const filterArgs = options?.clean ? ["-af", ASR_AUDIO_FILTER] : [];
  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    ...inputArgs(source),
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    ...filterArgs,
    "-ac",
    String(AUDIO_CHANNELS),
    "-ar",
    String(sampleRate),
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    out,
  ];
}

export async function extractAudio(
  context: DeriveContext,
  sampleRate: number,
  out: string,
  options?: { clean?: boolean },
): Promise<void> {
  await runGraph(context, audioArgs(sampleRate, context.source, out, options), "audio extraction");
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

export interface ProxySize {
  readonly width: number;
  readonly height: number;
}

/**
 * The proxy's dimensions: shortest side to 540, both even, never upscaled.
 *
 * Computed here rather than in a filtergraph expression on purpose. `scale` can
 * do this with nested `if(gt(iw,ih),...)` calls, but every comma in them has to
 * be escaped through two levels of ffmpeg's own parser, and getting that wrong
 * produces a filtergraph that fails at runtime on exactly the aspect ratio nobody
 * tested. Two integers computed in TypeScript are testable in a millisecond.
 *
 * Shortest side, not height, because this is a product for vertical video: a
 * 1080×1920 phone clip scaled to 540 *height* would be 304 px wide, which is not
 * a preview anyone can cut on.
 */
export function proxySize(width: number, height: number): ProxySize {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };

  const shortest = Math.min(width, height);
  const scale = shortest <= PROXY_SHORT_SIDE ? 1 : PROXY_SHORT_SIDE / shortest;
  return { width: even(width * scale), height: even(height * scale) };
}

/** Round to an even number ≥ 2: H.264 4:2:0 cannot encode odd dimensions. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The tone-mapping chain for a PQ or HLG source.
 *
 * Linearise, convert the primaries, tone-map with Hable, then land on BT.709
 * limited range. Without it an HDR source encoded straight to an SDR proxy comes
 * out grey and desaturated — the classic "why does my iPhone video look washed
 * out" — because the PQ curve is interpreted as if it were gamma 2.4.
 *
 * `desat=0` because the default desaturation is tuned for display mapping of
 * bright highlights and, on the phone footage this product actually sees, it
 * mostly removes skin tone.
 */
export function toneMapFilter(): string {
  return [
    "zscale=transfer=linear:npl=100",
    "format=gbrpf32le",
    "zscale=primaries=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=transfer=bt709:matrix=bt709:range=tv",
  ].join(",");
}

/** The video filter chain for a proxy: tone-map when HDR, then scale and pack. */
export function proxyFilter(size: ProxySize, hdr: boolean): string {
  return [
    ...(hdr ? [toneMapFilter()] : []),
    `scale=${String(size.width)}:${String(size.height)}:flags=bicubic`,
    // The proxy is played in a browser, and 10-bit or 4:2:2 H.264 is not.
    "format=yuv420p",
  ].join(",");
}

export function proxyArgs(input: {
  readonly source: string;
  readonly out: string;
  readonly size: ProxySize;
  readonly hdr: boolean;
  readonly hasAudio: boolean;
}): string[] {
  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    // Progress on stderr in a machine-readable form, so the heartbeat can report a
    // real percentage rather than a guess.
    "-progress",
    "pipe:2",
    "-stats_period",
    "5",
    ...inputArgs(input.source),
    "-map",
    "0:v:0",
    ...(input.hasAudio ? ["-map", "0:a:0"] : ["-an"]),
    "-sn",
    "-dn",
    "-vf",
    proxyFilter(input.size, input.hdr),
    "-c:v",
    "libx264",
    // `main`, not `baseline`: baseline has no CABAC, which costs about 10% of the
    // bitrate for compatibility with phones that stopped shipping in 2012.
    "-profile:v",
    "main",
    "-preset",
    "veryfast",
    "-crf",
    String(PROXY_CRF),
    "-pix_fmt",
    "yuv420p",
    ...(input.hasAudio ? ["-c:a", "aac", "-b:a", PROXY_AUDIO_BITRATE, "-ac", "2"] : []),
    // The moov atom at the front: without it the browser has to fetch the end of
    // the file before it can show the first frame.
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.out,
  ];
}

/**
 * Encode the proxy, falling back to a plain BT.709 conversion if tone-mapping is
 * not available.
 *
 * `zscale` is `libzimg`, and a distribution's ffmpeg may be built without it. The
 * fallback loses the tone curve — an HDR proxy that looks flat — which is a far
 * better outcome than an upload that cannot be edited at all.
 */
export async function encodeProxy(
  context: DeriveContext,
  input: {
    readonly out: string;
    readonly size: ProxySize;
    readonly hdr: boolean;
    readonly hasAudio: boolean;
  },
  onProgress?: (chunk: string) => void,
): Promise<{ readonly toneMapped: boolean }> {
  const args = proxyArgs({ ...input, source: context.source });
  const first = await run(context.binary, args, {
    timeoutMs: context.timeoutMs,
    ...(onProgress === undefined ? {} : { onStderr: onProgress }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (first.code === 0) return { toneMapped: input.hdr };

  if (!input.hdr) throw encodeFailed(first.stderr);

  const fallback = await run(
    context.binary,
    proxyArgs({ ...input, source: context.source, hdr: false }),
    {
      timeoutMs: context.timeoutMs,
      ...(onProgress === undefined ? {} : { onStderr: onProgress }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  );
  if (fallback.code !== 0) throw encodeFailed(fallback.stderr);
  return { toneMapped: false };
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/**
 * When to grab thumbnail `index` of `count`, in seconds.
 *
 * The midpoint of each equal slice, not its edge. Frame zero of a clip is very
 * often black or a slate, and the last frame is very often a fade — the midpoints
 * are the frames a human would have picked.
 */
export function thumbnailOffsetMs(durationMs: number, index: number, count: number): number {
  if (durationMs <= 0 || count <= 0) return 0;
  return Math.floor((durationMs * (index + 0.5)) / count);
}

export function thumbnailArgs(input: {
  readonly source: string;
  readonly out: string;
  readonly atMs: number;
}): string[] {
  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    // BEFORE `-i`: input seek, one range request. After it, a full decode.
    "-ss",
    (input.atMs / 1000).toFixed(3),
    ...inputArgs(input.source),
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    "-vf",
    `scale=${String(THUMBNAIL_WIDTH)}:-2:flags=bicubic`,
    "-q:v",
    String(THUMBNAIL_QUALITY),
    "-f",
    "image2",
    input.out,
  ];
}

/**
 * Grab one frame. Returns `false` when ffmpeg produced nothing.
 *
 * A miss is not a failure: seeking into the tail of a variable-frame-rate file
 * recorded by a phone that stopped mid-GOP genuinely finds no frame, and a
 * filmstrip of nine images is not a broken upload.
 */
export async function grabThumbnail(
  context: DeriveContext,
  out: string,
  atMs: number,
): Promise<boolean> {
  const result = await run(context.binary, thumbnailArgs({ source: context.source, out, atMs }), {
    timeoutMs: context.timeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return result.code === 0;
}

// ---------------------------------------------------------------------------

async function runGraph(
  context: DeriveContext,
  args: readonly string[],
  what: string,
): Promise<void> {
  const result = await run(context.binary, args, {
    timeoutMs: context.timeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (result.code !== 0) {
    throw unreadableMedia(
      `This file could not be processed (${what}).`,
      "media/corrupt",
      result.stderr,
    );
  }
}

function encodeFailed(detail: string): Error {
  // Retryable: an encode dies for host reasons — a full disk, an OOM kill, a
  // dropped range request — at least as often as it dies for the file's.
  return transientFailure("media/encode_failed", "The proxy encode failed.", { detail });
}

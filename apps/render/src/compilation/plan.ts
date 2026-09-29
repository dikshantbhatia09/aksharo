/**
 * How a compilation is joined (2026-10-03): the pieces, and the ffmpeg command
 * line for each. Pure, so every frame count here is tested without a binary.
 *
 * ## Why pieces, not one filter graph
 *
 * One graph with every clip as an input and an `xfade` chain between them is
 * the obvious command, and on this product's hardware it does not fit: ffmpeg
 * opens every input at once, and each 1080 x 1920 decoder with its queues held
 * about 55 MB while it waited its turn (measured with ffmpeg 9, 2026-10-03:
 * 1.17 GB for sixteen inputs with the encoder held to four threads). Twenty
 * clips would take a render node's whole memory. So the video is made in
 * pieces, each from at most two inputs, and the pieces are joined without
 * re-encoding:
 *
 * ```
 * part:    [ card ]      [ clip 1 ]           [ clip 2 ]
 * pieces:  [body 0][fade][   body 1   ][fade][  body 2  ]
 *                   \___ card end + clip 1 start, crossfaded
 * ```
 *
 * - a **body** is one part with its fades' frames taken off each end;
 * - a **fade** is the last `F` frames of one part crossfaded (`xfade`, and
 *   `acrossfade` for the sound) into the first `F` frames of the next;
 * - every piece is encoded with identical settings into a MOV (H.264 and PCM),
 *   and the concat demuxer joins them with the video copied and the sound
 *   encoded to AAC once, so a join never repeats or drops a frame or a sample.
 *
 * Frame counts are exact by construction: each part is normalised to the
 * canvas, `fps` and 48 kHz stereo, padded by cloning its last frame and cut to
 * exactly its frame count (`tpad` + `trim`), and its sound padded with silence
 * and cut to exactly `frames x 48000 / fps` samples. A clip whose picture ends a
 * frame short, or whose sound ends early, still takes exactly its place.
 */

/** Every piece's sound: 48 kHz stereo, which a whole number of samples per frame needs. */
export const SAMPLE_RATE = 48_000;

/** A part as the worker measured it: a file, its length in frames, and whether it has sound. */
export interface PartSource {
  readonly path: string;
  readonly frames: number;
  readonly hasAudio: boolean;
}

export type Piece =
  | {
      readonly kind: "body";
      readonly part: number;
      /** First frame, inclusive. */
      readonly from: number;
      /** Last frame, exclusive. */
      readonly to: number;
    }
  | {
      readonly kind: "fade";
      /** The part that fades out; its last `frames` frames. */
      readonly from: number;
      /** The part that fades in; its first `frames` frames. */
      readonly into: number;
      readonly frames: number;
    };

export function framesOf(ms: number, fps: number): number {
  return Math.max(0, Math.round((ms * fps) / 1000));
}

export function samplesPerFrame(fps: number): number {
  if (!Number.isInteger(fps) || fps <= 0 || SAMPLE_RATE % fps !== 0) {
    throw new RangeError(`a frame rate that splits 48 kHz evenly is needed, not ${String(fps)}`);
  }
  return SAMPLE_RATE / fps;
}

/**
 * The fade actually used, in frames: the one asked for, shortened only where
 * a body would otherwise be left with no frame - the first and last parts lose
 * one fade, every part between them two. Zero with one part. Clips are three
 * seconds or more, so in practice this is the fade asked for.
 */
export function fadeFramesFor(requested: number, frames: readonly number[]): number {
  if (frames.length < 2 || requested <= 0) return 0;
  const room = frames.map((count, part) =>
    part === 0 || part === frames.length - 1 ? count - 1 : Math.floor((count - 1) / 2),
  );
  return Math.max(0, Math.min(Math.floor(requested), ...room));
}

/** The pieces, in playing order ({@link Piece}). */
export function planPieces(frames: readonly number[], fade: number): Piece[] {
  const pieces: Piece[] = [];
  frames.forEach((count, part) => {
    const from = part === 0 ? 0 : fade;
    const to = part === frames.length - 1 ? count : count - fade;
    if (to > from) pieces.push({ kind: "body", part, from, to });
    if (part < frames.length - 1 && fade > 0) {
      pieces.push({ kind: "fade", from: part, into: part + 1, frames: fade });
    }
  });
  return pieces;
}

export function pieceFrames(piece: Piece): number {
  return piece.kind === "body" ? piece.to - piece.from : piece.frames;
}

/** The joined video's length in frames: every part, less one fade per join. */
export function totalFrames(frames: readonly number[], fade: number): number {
  return frames.reduce((sum, count) => sum + count, 0) - fade * Math.max(0, frames.length - 1);
}

/** The index of the last piece that reads each part, so its file can go once it is done. */
export function lastUse(pieces: readonly Piece[], parts: number): number[] {
  const last = new Map<number, number>();
  pieces.forEach((piece, index) => {
    const used = piece.kind === "body" ? [piece.part] : [piece.from, piece.into];
    for (const part of used) last.set(part, index);
  });
  return Array.from({ length: parts }, (_, part) => last.get(part) ?? -1);
}

export interface PieceOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** x264 threads per piece: bounds a piece's memory (about 400 MB at 1080 x 1920 with four). */
  readonly encoderThreads: number;
  readonly logLevel?: string;
}

function seconds(frames: number, fps: number): string {
  return (frames / fps).toFixed(6);
}

/**
 * One part's picture, normalised and cut to `count` frames: fitted inside the
 * canvas and padded (a part of another shape is letterboxed, never cropped),
 * square pixels, `fps` from the start, 4:2:0, then held to exactly `count`
 * frames. `start_time=0` makes a part whose first frame is late begin on time.
 */
export function videoChain(input: string, count: number, options: PieceOptions): string {
  const { width, height, fps } = options;
  return (
    `[${input}]scale=${String(width)}:${String(height)}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${String(width)}:${String(height)}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,` +
    `fps=${String(fps)}:start_time=0,format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${String(count)},setpts=PTS-STARTPTS`
  );
}

/**
 * One part's sound as exactly `count` frames' worth of 48 kHz stereo: a gap at
 * the start filled (`first_pts=0`), short sound padded with silence, long sound
 * cut. A part with no sound is silence of the same length.
 */
export function audioChain(input: string | null, count: number, fps: number): string {
  const samples = count * samplesPerFrame(fps);
  if (input === null) {
    return (
      `anullsrc=r=${String(SAMPLE_RATE)}:cl=stereo,atrim=end_sample=${String(samples)},` +
      `aformat=sample_fmts=s16:channel_layouts=stereo,asetpts=PTS-STARTPTS`
    );
  }
  return (
    `[${input}]aresample=${String(SAMPLE_RATE)}:async=1:first_pts=0,` +
    `aformat=sample_fmts=s16:channel_layouts=stereo,` +
    `apad=whole_len=${String(samples)},atrim=end_sample=${String(samples)},asetpts=PTS-STARTPTS`
  );
}

/**
 * The encode every piece shares. Identical settings are what let the pieces
 * be joined without re-encoding: the same size, rate, profile and keyframe
 * rhythm give every piece the same parameter sets. PCM sound, so the one AAC
 * encode at the end sees one continuous track (AAC's priming samples at every
 * join would drift the sound a frame per clip).
 */
export function pieceEncodeArgs(options: PieceOptions): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(options.fps * 2),
    "-bf",
    "2",
    "-threads",
    String(options.encoderThreads),
    "-c:a",
    "pcm_s16le",
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "2",
    "-f",
    "mov",
  ];
}

function baseArgs(options: PieceOptions): string[] {
  return ["-hide_banner", "-nostdin", "-loglevel", options.logLevel ?? "error", "-y"];
}

/**
 * An input read from frame `from` on. A seek before `-i` is exact when
 * transcoding (ffmpeg decodes from the keyframe before it and drops frames up
 * to it), so a fade out of a minute-long clip decodes half a second, not the
 * whole clip. Two decoder threads each: a piece reads at most two parts.
 */
function inputArgs(path: string, from: number, fps: number): string[] {
  return [...(from > 0 ? ["-ss", seconds(from, fps)] : []), "-threads", "2", "-i", path];
}

/** The ffmpeg arguments that make one piece into `out`. */
export function pieceArgs(
  piece: Piece,
  parts: readonly PartSource[],
  out: string,
  options: PieceOptions,
): string[] {
  const { fps } = options;
  if (piece.kind === "body") {
    const part = parts.at(piece.part);
    if (part === undefined) throw new RangeError(`no part ${String(piece.part)}`);
    const count = piece.to - piece.from;
    return [
      ...baseArgs(options),
      ...inputArgs(part.path, piece.from, fps),
      "-filter_complex",
      `${videoChain("0:v", count, options)}[v];` +
        `${audioChain(part.hasAudio ? "0:a" : null, count, fps)}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      ...pieceEncodeArgs(options),
      out,
    ];
  }

  const from = parts.at(piece.from);
  const into = parts.at(piece.into);
  if (from === undefined || into === undefined) {
    throw new RangeError(`no parts ${String(piece.from)}/${String(piece.into)}`);
  }
  const count = piece.frames;
  return [
    ...baseArgs(options),
    ...inputArgs(from.path, Math.max(0, from.frames - count), fps),
    ...inputArgs(into.path, 0, fps),
    "-filter_complex",
    `${videoChain("0:v", count, options)}[va];` +
      `${videoChain("1:v", count, options)}[vb];` +
      // Held to the count after the crossfade too: `xfade` rounds its own end.
      `[va][vb]xfade=transition=fade:duration=${seconds(count, fps)}:offset=0,` +
      `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${String(count)},setpts=PTS-STARTPTS[v];` +
      `${audioChain(from.hasAudio ? "0:a" : null, count, fps)}[aa];` +
      `${audioChain(into.hasAudio ? "1:a" : null, count, fps)}[ab];` +
      `[aa][ab]acrossfade=ns=${String(count * samplesPerFrame(fps))}:c1=tri:c2=tri[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...pieceEncodeArgs(options),
    out,
  ];
}

/**
 * The title card's encode: RGBA frames on stdin (Skia draws them), silence
 * beside them, exactly `count` frames. Kept a little finer than the pieces
 * (CRF 16), since the card is encoded again when its pieces are made.
 */
export function cardArgs(count: number, out: string, options: PieceOptions): string[] {
  const { width, height, fps } = options;
  return [
    "-hide_banner",
    "-loglevel",
    options.logLevel ?? "error",
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${String(width)}x${String(height)}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${String(SAMPLE_RATE)}:cl=stereo`,
    "-filter_complex",
    `[0:v]format=yuv420p,setsar=1[v];` +
      `[1:a]atrim=end_sample=${String(count * samplesPerFrame(fps))},asetpts=PTS-STARTPTS[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-frames:v",
    String(count),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    String(options.encoderThreads),
    "-c:a",
    "pcm_s16le",
    "-f",
    "mov",
    out,
  ];
}

/**
 * The concat demuxer's list: the pieces by their bare file names (the list
 * sits beside them, so no path needs quoting and the demuxer's safe mode
 * holds), each with its exact duration so the joins land on whole frames.
 */
export function concatList(
  pieces: readonly { readonly file: string; readonly frames: number }[],
  fps: number,
): string {
  const lines: string[] = ["ffconcat version 1.0"];
  for (const piece of pieces) {
    if (!/^[A-Za-z0-9._-]+$/.test(piece.file)) {
      throw new RangeError(`a piece's file name must be a bare name, not ${piece.file}`);
    }
    lines.push(`file ${piece.file}`, `duration ${seconds(piece.frames, fps)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Joins the pieces: the picture copied, the sound encoded once to AAC, the index up front. */
export function concatArgs(listPath: string, out: string, options: PieceOptions): string[] {
  return [
    ...baseArgs(options),
    "-f",
    "concat",
    "-i",
    listPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    String(SAMPLE_RATE),
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    out,
  ];
}

/**
 * What an uploaded music track really is (2026-10-04): its format from its
 * first bytes and its length from its headers, without decoding it - the
 * music twin of `image-probe.ts`.
 *
 * The declared content type is only a claim (the browser takes it from the
 * file name), and a presigned PUT holds the upload to the type it was signed
 * for, not to what the bytes are. So a track is accepted only when its bytes
 * open as the MP3, WAV or M4A it claims, and its length - which the kit holds
 * to a limit - is read here from the container: a WAV's data size over its
 * byte rate, an M4A's movie header, an MP3's Xing/Info or VBRI frame count or,
 * for a constant-bit-rate file without one, its size over its bit rate.
 *
 * Nothing here decodes audio; the renderer probes the file itself before it
 * mixes it (`probeAudioAsset`), so a length that is a little off (an MP3's
 * encoder padding) changes nothing but the limit check.
 */

export type AudioFormat = "mp3" | "wav" | "m4a";

export interface AudioFacts {
  readonly format: AudioFormat;
  readonly durationMs: number;
}

function ascii(bytes: Uint8Array, from: number, length: number): string {
  let text = "";
  for (let index = from; index < from + length && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes.at(index) ?? 0);
  }
  return text;
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes.at(at) ?? 0) | ((bytes.at(at + 1) ?? 0) << 8);
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    ((bytes.at(at) ?? 0) |
      ((bytes.at(at + 1) ?? 0) << 8) |
      ((bytes.at(at + 2) ?? 0) << 16) |
      ((bytes.at(at + 3) ?? 0) << 24)) >>>
    0
  );
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes.at(at) ?? 0) << 24) |
      ((bytes.at(at + 1) ?? 0) << 16) |
      ((bytes.at(at + 2) ?? 0) << 8) |
      (bytes.at(at + 3) ?? 0)) >>>
    0
  );
}

/** A 64-bit big-endian length, as a number (exact below 2^53, far past any upload). */
function u64be(bytes: Uint8Array, at: number): number {
  return u32be(bytes, at) * 2 ** 32 + u32be(bytes, at + 4);
}

function wholeMs(seconds: number): number | undefined {
  const ms = Math.round(seconds * 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/** RIFF/WAVE: the `fmt ` chunk's byte rate, and the `data` chunk's size. */
function wav(bytes: Uint8Array): AudioFacts | undefined {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return undefined;
  }
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = u32le(bytes, offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      const channels = u16le(bytes, body + 2);
      const sampleRate = u32le(bytes, body + 4);
      byteRate = u32le(bytes, body + 8);
      if (channels === 0 || sampleRate === 0 || byteRate === 0) return undefined;
    } else if (id === "data") {
      if (byteRate === 0) return undefined;
      // A streamed WAV says 0 or 0xFFFFFFFF: the data runs to the end.
      const available = bytes.length - body;
      const dataSize = size === 0 || size === 0xffffffff ? available : Math.min(size, available);
      const durationMs = wholeMs(dataSize / byteRate);
      return durationMs === undefined ? undefined : { format: "wav", durationMs };
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// M4A (MP4)
// ---------------------------------------------------------------------------

interface Box {
  readonly type: string;
  /** Where its contents start, and where it ends. */
  readonly body: number;
  readonly end: number;
}

/** The boxes directly inside `[from, to)`. */
function boxes(bytes: Uint8Array, from: number, to: number): Box[] {
  const found: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > to) break;
      size = u64be(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header || offset + size > to) break;
    found.push({ type, body: offset + header, end: offset + size });
    offset += size;
  }
  return found;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | undefined {
  return boxes(bytes, parent.body, parent.end).find((box) => box.type === type);
}

/** Whether a `trak` is a sound track: its `mdia/hdlr` handler is `soun`. */
function isSoundTrack(bytes: Uint8Array, trak: Box): boolean {
  const mdia = child(bytes, trak, "mdia");
  const hdlr = mdia === undefined ? undefined : child(bytes, mdia, "hdlr");
  // version + flags (4), pre_defined (4), then the handler type.
  return hdlr !== undefined && ascii(bytes, hdlr.body + 8, 4) === "soun";
}

/** ISO BMFF with a sound track: the movie header's duration over its timescale. */
function m4a(bytes: Uint8Array): AudioFacts | undefined {
  const top = boxes(bytes, 0, bytes.length);
  if (top[0]?.type !== "ftyp") return undefined;
  const moov = top.find((box) => box.type === "moov");
  if (moov === undefined) return undefined;
  const inside = boxes(bytes, moov.body, moov.end);
  if (!inside.some((box) => box.type === "trak" && isSoundTrack(bytes, box))) return undefined;
  const mvhd = inside.find((box) => box.type === "mvhd");
  if (mvhd === undefined) return undefined;
  const version = bytes.at(mvhd.body) ?? 0;
  // After version + flags: two dates (4 or 8 bytes each), the timescale, the duration.
  const timescale = u32be(bytes, mvhd.body + (version === 1 ? 20 : 12));
  const duration = version === 1 ? u64be(bytes, mvhd.body + 24) : u32be(bytes, mvhd.body + 16);
  if (timescale === 0) return undefined;
  const durationMs = wholeMs(duration / timescale);
  return durationMs === undefined ? undefined : { format: "m4a", durationMs };
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

/** kbit/s by bitrate index, for MPEG-1 Layer III and MPEG-2/2.5 Layer III. */
const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** Hz by sample-rate index, for MPEG-1; MPEG-2 halves it, MPEG-2.5 quarters it. */
const MPEG1_RATES = [44_100, 48_000, 32_000];

interface Mp3Frame {
  readonly mpeg1: boolean;
  readonly mono: boolean;
  readonly sampleRate: number;
  readonly bitrate: number;
  readonly samples: number;
  readonly length: number;
}

/** A Layer III frame header at `at`, or `undefined`. */
function mp3Frame(bytes: Uint8Array, at: number): Mp3Frame | undefined {
  const b0 = bytes.at(at);
  const b1 = bytes.at(at + 1);
  const b2 = bytes.at(at + 2);
  const b3 = bytes.at(at + 3);
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    return undefined;
  }
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
  const version = (b1 >> 3) & 0x03; // 0: 2.5, 1: reserved, 2: 2, 3: 1
  const layer = (b1 >> 1) & 0x03; // 1: Layer III
  if (version === 1 || layer !== 1) return undefined;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS).at(bitrateIndex) ?? 0;
  const baseRate = MPEG1_RATES.at(rateIndex) ?? 0;
  const sampleRate = mpeg1 ? baseRate : version === 2 ? baseRate / 2 : baseRate / 4;
  const padding = (b2 >> 1) & 0x01;
  const bitrate = kbps * 1000;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  if (length < 24) return undefined;
  return { mpeg1, mono: b3 >> 6 === 3, sampleRate, bitrate, samples, length };
}

/** Where the audio starts: after an ID3v2 tag, if there is one. */
function id3End(bytes: Uint8Array): number {
  if (ascii(bytes, 0, 3) !== "ID3" || bytes.length < 10) return 0;
  // A syncsafe size: seven bits a byte.
  const size =
    (((bytes.at(6) ?? 0) & 0x7f) << 21) |
    (((bytes.at(7) ?? 0) & 0x7f) << 14) |
    (((bytes.at(8) ?? 0) & 0x7f) << 7) |
    ((bytes.at(9) ?? 0) & 0x7f);
  const footer = ((bytes.at(5) ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** How far into the audio a first frame is looked for: past any junk an encoder leaves. */
const MP3_SYNC_WINDOW = 64 * 1024;

function mp3(bytes: Uint8Array): AudioFacts | undefined {
  const start = id3End(bytes);
  let at = -1;
  let frame: Mp3Frame | undefined;
  for (let offset = start; offset < Math.min(bytes.length - 4, start + MP3_SYNC_WINDOW); offset++) {
    const candidate = mp3Frame(bytes, offset);
    if (candidate === undefined) continue;
    // A frame is only believed when the next one starts where it says it ends
    // (or it is the only one): random bytes pass one check, rarely two.
    const next = offset + candidate.length;
    if (next + 4 <= bytes.length && mp3Frame(bytes, next) === undefined) continue;
    at = offset;
    frame = candidate;
    break;
  }
  if (frame === undefined || at < 0) return undefined;

  // Xing/Info (LAME and most VBR encoders): after the side information.
  const side = frame.mpeg1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xing = at + 4 + side;
  const tag = ascii(bytes, xing, 4);
  if ((tag === "Xing" || tag === "Info") && (u32be(bytes, xing + 4) & 0x01) !== 0) {
    const frames = u32be(bytes, xing + 8);
    const durationMs = wholeMs((frames * frame.samples) / frame.sampleRate);
    if (durationMs !== undefined) return { format: "mp3", durationMs };
  }
  // VBRI (Fraunhofer): 32 bytes after the header.
  if (ascii(bytes, at + 36, 4) === "VBRI") {
    const frames = u32be(bytes, at + 36 + 14);
    const durationMs = wholeMs((frames * frame.samples) / frame.sampleRate);
    if (durationMs !== undefined) return { format: "mp3", durationMs };
  }
  // Constant bit rate: the audio's size over the rate, less an ID3v1 tag.
  const tail = bytes.length >= 128 && ascii(bytes, bytes.length - 128, 3) === "TAG" ? 128 : 0;
  const audioBytes = bytes.length - at - tail;
  const durationMs = wholeMs((audioBytes * 8) / frame.bitrate);
  return durationMs === undefined ? undefined : { format: "mp3", durationMs };
}

/** The track's format and length, or `undefined` when it is none of MP3, WAV or M4A. */
export function probeAudio(bytes: Uint8Array): AudioFacts | undefined {
  return wav(bytes) ?? m4a(bytes) ?? mp3(bytes);
}

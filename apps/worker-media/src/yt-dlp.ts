import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  type MediaFailureReason,
  type MediaJobError,
  redact,
  sourceRefused,
  stderrTail,
  transientFailure,
} from "./errors.js";
import { run } from "./ffmpeg/run.js";
import { logger } from "./logger.js";

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * The external-source downloader (REP-010), and every rule that keeps it safe.
 *
 * This is the first media job that writes bytes to disk. `media.probe` reads its
 * source through a presigned URL and never downloads it; acquisition genuinely
 * fetches a file from the public internet, on behalf of a user, using a binary
 * this repository does not build. Every constraint below exists because of a
 * specific way that goes wrong:
 *
 * - **The version is PINNED and CHECKSUMMED.** `EXPECTED_VERSION` is the release
 *   ADR 0002 §7 names, and `assertYtDlpUsable` refuses to start against
 *   anything else (a package-manager build may be let through with a warning,
 *   but only when its deployment asks for that by name — see there). A
 *   downloader that updates itself at container boot is an unreviewed
 *   executable change entering the acquisition path between two deploys of
 *   identical images.
 * - **`--update` is impossible**, because `NEVER_ALLOWED_ARGS` is checked against
 *   the argument list actually built, not against the inputs that produced it.
 * - **Arguments come from a closed list.** `buildArgs` emits a fixed sequence and
 *   interpolates exactly one caller value — the URL — which
 *   `assertAcquirableUrl` has already reduced to a normalised HTTPS URL on a
 *   recognised host. There is no shell anywhere in this file: `run()` uses
 *   `spawn`, so the URL reaches `execve` as one argv entry (THREAT-MODEL T7).
 * - **Metadata is fetched before bytes.** `probeSource` is a JSON dump with
 *   `--skip-download`, so a video that is too long, live, or unavailable is
 *   refused for the price of one metadata request rather than a partial download.
 * - **Playlists are refused, not truncated.** `--no-playlist` plus an explicit
 *   check: silently importing entry one of a playlist is a different thing from
 *   what the user asked for.
 * - **Every limit is enforced more than once** — against the metadata, against
 *   the bytes on disk while they arrive, and against what actually landed. A
 *   source can lie about its duration, and `--max-filesize` is only a check on
 *   one HTTP response: it never fires for an HLS/DASH stream fetched in
 *   fragments, and for a split download it applies to each part, not the sum.
 * - **Both output streams are read.** yt-dlp prints progress AND its
 *   `--max-filesize` abort to stdout, and on that abort it exits 0 without
 *   writing the file; only ERROR and WARNING lines go to stderr.
 *
 * Nothing in this file runs while `source_youtube_acquire` is disabled, which is
 * how it is seeded. The binary is NOT vendored into the repository; the media
 * worker's Dockerfile installs exactly this version and verifies this digest.
 */

/**
 * The pinned release (ADR 0002 §7). Changing it is a reviewed dependency PR with
 * the acquisition and security suites attached — never a runtime decision.
 */
export const EXPECTED_VERSION = "2026.08.19";

/**
 * SHA-256 of the official standalone Linux build of {@link EXPECTED_VERSION}.
 *
 * `null` until the release is fetched and its digest recorded in the Wave 0
 * register by the person who verifies it against the publisher's own checksum
 * file. It is deliberately not a placeholder digit string: a wrong constant here
 * would either wedge every deployment or, worse, be "fixed" by pasting whatever
 * the local file happens to hash to, which is how an unverified binary gets
 * blessed. Until it is recorded, `assertYtDlpUsable` refuses to run in
 * production and says exactly what is missing.
 */
export const EXPECTED_SHA256: string | null = null;

/**
 * Arguments that must never appear, whatever produced them.
 *
 * Checked against the built list rather than the inputs, so a future edit to
 * `buildArgs` cannot reintroduce one by accident. `--exec` and `--downloader` run
 * other programs; `--update` replaces this binary; the config-file flags let a
 * file on disk add arguments this module never wrote.
 */
export const NEVER_ALLOWED_ARGS = [
  "--exec",
  "--exec-before-download",
  "--downloader",
  "--external-downloader",
  "--update",
  "-U",
  "--update-to",
  "--config-location",
  "--load-info-json",
  "--batch-file",
  "-a",
  "--cookies",
  "--cookies-from-browser",
] as const;

export interface AcquireLimits {
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly timeoutMs: number;
}

export interface SourceMetadata {
  readonly provider: string;
  readonly sourceId: string | null;
  readonly title: string | null;
  readonly channel: string | null;
  readonly durationMs: number | null;
  readonly isLive: boolean;
  /** Size of what WILL be downloaded (the chosen streams), not of the largest format. */
  readonly approximateBytes: number | null;
  /**
   * The exact streams to download (`137+140`), chosen by {@link chooseFormat}
   * from the probe's own format list; `null` when the source listed none, and
   * the download falls back to {@link FALLBACK_FORMAT}.
   */
  readonly formatSelector?: string | null;
}

/*
 * Every size below is the picture's SHORT side — yt-dlp's own `res` — never
 * its `height`. yt-dlp reports a vertical video's real pixel height, so a
 * 1080 x 1920 Short is "1920 tall", and a cap on height fetched it at
 * 480 x 854: under the old fixed 720 x 1280 clip, and upscaled 2.25x by every
 * 1080 x 1920 export.
 */

/**
 * The largest picture worth fetching, when its streams fit both budgets (the
 * byte cap, and {@link ASSUMED_DOWNLOAD_BYTES_PER_S} over the time limit).
 *
 * A clip keeps a landscape source's full height and cuts a 9:16 window out of
 * it (`clipFrame`), so the clip is exactly as tall as the source: 2160p gives a
 * 1216 x 2160 window scaled to the canvas's 1080 x 1920, 1440p gives
 * 810 x 1440, and 1080p only 608 x 1080 — a picture every export then scales
 * up 1.78x. Of landscape sources only 2160p fills the canvas (a portrait one
 * does at 1080 x 1920), so it is worth its bytes whenever they fit; anything
 * larger is scaled away.
 */
export const MAX_SOURCE_SHORT_SIDE = 2160;

/**
 * The largest picture fetched without showing that it fits. Above this a
 * stream has to prove two things: that it fits the plan's byte cap — 4K is the
 * stream that blew it, an 18-minute talk being 556 MB in 4K AV1 against the
 * Free plan's 500 MB (2026-09-25) — and that it can arrive inside the
 * download's time limit. So the fallback selector, and a source whose formats
 * give neither a size nor a bitrate, get nothing larger.
 *
 * At or under it, only the byte cap decides, as it did before anything larger
 * was fetched at all.
 */
export const DEFAULT_MAX_SHORT_SIDE = 1080;

/** The smallest picture worth making a clip from, when the source offers better. */
export const MIN_SOURCE_SHORT_SIDE = 360;

/** Estimates are estimates: leave room under the cap for what actually lands. */
const BUDGET_HEADROOM = 0.9;

/**
 * The download speed a picture above {@link DEFAULT_MAX_SHORT_SIDE} is planned
 * for: 8 Mbit/s, a modest connection. The byte cap is not the only brake — the
 * download also has a fixed time limit (40 minutes, whatever the plan), and a
 * paid plan's cap is large enough to admit a 3-hour talk in 4K (about 5.4 GB,
 * 18 Mbit/s sustained to land in time) when 1080p of it is 1.9 GB. A timed-out
 * download is retried, holding the one shared acquisition slot each time, and
 * then fails the run that 1080p would have finished. So a larger picture must
 * also arrive in time at this speed; an 18-minute talk in 1440p (284 MB) needs
 * under 1 Mbit/s, and one hour of 4K about 6.
 */
export const ASSUMED_DOWNLOAD_BYTES_PER_S = 1_000_000;

/**
 * When the source lists no usable formats: yt-dlp's own chooser, told the
 * same preferences through {@link FALLBACK_SORT}.
 *
 * Not a format filter. A filter compares one field with a constant, never
 * height with width, so `[height<=1080]` is a portrait video's LONG side and
 * nothing in filter syntax can say "short side". The sort can: its `res` is
 * the smaller dimension.
 */
export const FALLBACK_FORMAT = "bv*+ba/b";

/**
 * The fallback's order: the largest picture at or under
 * {@link DEFAULT_MAX_SHORT_SIDE} on its short side (the smallest above it when
 * there is nothing under), then H.264 before VP9 before AV1 and AAC first —
 * yt-dlp's documented `+codec:avc:m4a`. Checked offline against 2026.08.19's
 * own selector: a landscape list takes 1920 x 1080 H.264 + m4a, a Short's takes
 * 1080 x 1920, where the old height filter took 480 x 854.
 */
export const FALLBACK_SORT = `res:${String(DEFAULT_MAX_SHORT_SIDE)},+codec:avc:m4a`;

/** One entry of the probe's `formats` array, as far as the chooser reads it. */
export interface ProbeFormat {
  readonly format_id?: unknown;
  readonly vcodec?: unknown;
  readonly acodec?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly ext?: unknown;
  readonly protocol?: unknown;
  readonly filesize?: unknown;
  readonly filesize_approx?: unknown;
  readonly tbr?: unknown;
  readonly abr?: unknown;
  readonly format_note?: unknown;
  readonly language_preference?: unknown;
  readonly has_drm?: unknown;
}

export interface FormatChoice {
  readonly selector: string;
  /** As yt-dlp reports it: a portrait video's long side. For reporting only. */
  readonly height: number | null;
  /** The size every rule here is decided on: the smaller of width and height. */
  readonly shortSide: number | null;
  /** Estimated size of the chosen streams together; `null` when the source did not say. */
  readonly bytes: number | null;
}

function codecRank(vcodec: string): number {
  if (vcodec.startsWith("avc1") || vcodec.startsWith("h264")) return 0;
  if (vcodec.startsWith("vp09") || vcodec.startsWith("vp9")) return 1;
  if (vcodec.startsWith("av01")) return 2;
  return 3;
}

function sizeOf(format: ProbeFormat, durationS: number | null): number | null {
  if (typeof format.filesize === "number" && format.filesize > 0) return format.filesize;
  if (typeof format.filesize_approx === "number" && format.filesize_approx > 0) {
    return format.filesize_approx;
  }
  if (typeof format.tbr === "number" && format.tbr > 0 && durationS !== null) {
    return Math.round((format.tbr * 1000 * durationS) / 8);
  }
  return null;
}

const vcodecOf = (format: ProbeFormat): string =>
  typeof format.vcodec === "string" ? format.vcodec : "none";
const acodecOf = (format: ProbeFormat): string =>
  typeof format.acodec === "string" ? format.acodec : "none";
const heightOf = (format: ProbeFormat): number | null =>
  typeof format.height === "number" && format.height > 0 ? format.height : null;
const widthOf = (format: ProbeFormat): number | null =>
  typeof format.width === "number" && format.width > 0 ? format.width : null;

/**
 * The picture's short side, as yt-dlp's `res` measures it. A format that gives
 * no width is taken to be landscape, which is what its height meant before
 * widths were read at all.
 */
function shortSideOf(format: ProbeFormat): number | null {
  const height = heightOf(format);
  if (height === null) return null;
  const width = widthOf(format);
  return width === null ? height : Math.min(width, height);
}

const isHls = (format: ProbeFormat): boolean =>
  typeof format.protocol === "string" && format.protocol.includes("m3u8");

/** The audio track to pair with a video-only stream: original language, AAC, no DRC. */
function pickAudio(formats: readonly ProbeFormat[]): ProbeFormat | undefined {
  const original = (f: ProbeFormat): number =>
    (typeof f.format_note === "string" && f.format_note.includes("original")) ||
    (typeof f.language_preference === "number" && f.language_preference >= 10)
      ? 1
      : 0;
  const aac = (f: ProbeFormat): number => (f.ext === "m4a" || acodecOf(f).startsWith("mp4a") ? 1 : 0);
  const drc = (f: ProbeFormat): number => (String(f.format_id).includes("drc") ? 1 : 0);
  const abr = (f: ProbeFormat): number => (typeof f.abr === "number" ? f.abr : 0);
  const size = (f: ProbeFormat): number => sizeOf(f, null) ?? 0;
  return formats
    .filter((format) => vcodecOf(format) === "none" && acodecOf(format) !== "none")
    .sort(
      (a, b) =>
        original(b) - original(a) ||
        aac(b) - aac(a) ||
        drc(a) - drc(b) ||
        Number(isHls(a)) - Number(isHls(b)) ||
        abr(b) - abr(a) ||
        size(b) - size(a),
    )[0];
}

/**
 * Pick the streams to download: the largest picture — by its short side, up
 * to {@link MAX_SOURCE_SHORT_SIDE} — whose video and audio together fit the
 * plan's byte budget. The tallest that fits wins: 1440p AV1 inside the budget
 * beats 1080p H.264, because the clip is only ever as tall as its source. Only
 * between pictures of the same size does the rest decide: H.264 (cheapest to
 * decode downstream) over VP9 over AV1, a direct HTTPS stream over HLS, and
 * the original audio track over a dub. A picture above
 * {@link DEFAULT_MAX_SHORT_SIDE} must also be able to arrive inside the
 * download's time limit at {@link ASSUMED_DOWNLOAD_BYTES_PER_S}, or the choice
 * falls to the largest picture at or under it that fits the cap. A long video
 * steps down through the sizes, as far as {@link MIN_SOURCE_SHORT_SIDE},
 * rather than failing. When nothing fits, the smallest option is returned so
 * the limit check refuses it with the real reason. Sizes come from the
 * source, or from the bitrate; a source that gives neither gets its best
 * stream at or under {@link DEFAULT_MAX_SHORT_SIDE}, and the byte cap still
 * applies during and after the download.
 *
 * On the 18-minute talk that prompted the budget (youtube 5eW6Eagr9XA, Free
 * plan): 4K AV1 + audio is 556 MB and over it, so this takes 1440p AV1 +
 * audio at 284 MB — an 810 x 1440 clip rather than the 608 x 1080 a 1080p cap
 * gave. Three hours of the same on an 8 GB plan fits the cap in 4K (5.6 GB),
 * but not the 40 minutes at 8 Mbit/s (2.2 GB), and nor does 1440p (2.8 GB):
 * that takes 1080p H.264 at 1.9 GB.
 *
 * Exported for its tests; the probe is the only caller.
 */
export function chooseFormat(
  formats: readonly ProbeFormat[],
  limits: Pick<AcquireLimits, "maxBytes" | "timeoutMs">,
  durationS: number | null,
): FormatChoice | null {
  const usable = formats.filter(
    (format) => typeof format.format_id === "string" && format.has_drm !== true,
  );
  const audio = pickAudio(usable);

  const candidates: (FormatChoice & {
    readonly shortSide: number;
    readonly rank: number;
    readonly hls: boolean;
  })[] = [];
  for (const format of usable) {
    const shortSide = shortSideOf(format);
    if (vcodecOf(format) === "none" || shortSide === null || shortSide > MAX_SOURCE_SHORT_SIDE) {
      continue;
    }
    const height = heightOf(format);
    const videoBytes = sizeOf(format, durationS);
    if (acodecOf(format) === "none") {
      if (audio === undefined) continue;
      const audioBytes = sizeOf(audio, durationS);
      candidates.push({
        selector: `${String(format.format_id)}+${String(audio.format_id)}`,
        height,
        shortSide,
        bytes: videoBytes === null || audioBytes === null ? null : videoBytes + audioBytes,
        rank: codecRank(vcodecOf(format)),
        hls: isHls(format),
      });
    } else {
      candidates.push({
        selector: String(format.format_id),
        height,
        shortSide,
        bytes: videoBytes,
        rank: codecRank(vcodecOf(format)),
        hls: isHls(format),
      });
    }
  }
  if (candidates.length === 0) return null;
  // A clip cut from a postage stamp is not a clip. Below the floor only when the
  // source itself has nothing larger.
  const watchable = candidates.filter((candidate) => candidate.shortSide >= MIN_SOURCE_SHORT_SIDE);
  const pool = watchable.length > 0 ? watchable : candidates;

  pool.sort(
    (a, b) =>
      b.shortSide - a.shortSide ||
      a.rank - b.rank ||
      Number(a.bytes === null) - Number(b.bytes === null) ||
      Number(a.hls) - Number(b.hls) ||
      (a.bytes ?? 0) - (b.bytes ?? 0),
  );
  const budget = limits.maxBytes * BUDGET_HEADROOM;
  // What lands in the time limit at the assumed speed. Only a picture above
  // the default has to fit it: the rule is there so a larger picture never
  // costs a download that 1080p would have finished. At or under, the byte cap
  // alone decides, exactly as it did before anything larger was fetched.
  const inTime = ASSUMED_DOWNLOAD_BYTES_PER_S * (limits.timeoutMs / 1000) * BUDGET_HEADROOM;
  const fits = (candidate: {
    readonly shortSide: number;
    readonly bytes: number | null;
  }): boolean =>
    candidate.bytes !== null &&
    candidate.bytes <= budget &&
    (candidate.shortSide <= DEFAULT_MAX_SHORT_SIDE || candidate.bytes <= inTime);
  const sized = pool.filter((candidate) => candidate.bytes !== null);
  // The least of what there is, when everything is larger than the default:
  // the first of the smallest size, which is its preferred codec and protocol
  // (the pool's last is the least preferred of them — AV1 over HLS, say).
  const smallest = pool.at(-1)?.shortSide;
  // Decide on known sizes whenever there are any: a size-unknown stream at a
  // size whose known-size sibling is over the cap is over the cap too. With no
  // sizes at all, nothing shows that 4K fits, so it is not the gamble taken.
  const chosen =
    sized.length > 0
      ? (sized.find(fits) ?? [...sized].sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0))[0])
      : (pool.find((candidate) => candidate.shortSide <= DEFAULT_MAX_SHORT_SIDE) ??
        pool.find((candidate) => candidate.shortSide === smallest));
  if (chosen === undefined) return null;
  return {
    selector: chosen.selector,
    height: chosen.height,
    shortSide: chosen.shortSide,
    bytes: chosen.bytes,
  };
}

/** Thrown at boot when the pinned downloader is absent, wrong or unverified. */
export class DownloaderUnusableError extends Error {
  public override readonly name = "DownloaderUnusableError";
}

/**
 * Write to the pipes in UTF-8, whatever the host's code page.
 *
 * Without it yt-dlp encodes for the Windows ANSI code page, and Node reads the
 * pipe as UTF-8: YouTube's "you’re not a bot" and "channel’s members" arrived
 * with U+FFFD for the apostrophe (measured against 2026.08.19 on this host), so
 * a phrase with a non-ASCII character in it could never match.
 */
const UTF8_OUTPUT = ["--encoding", "utf-8"] as const;

/**
 * The argument list, in full, for one download.
 *
 * Every entry is a literal except `url`, and the numeric limits, which are
 * formatted from integers this module has already bounded. `-o` is a template
 * over a directory THIS process made (`withWorkspace`), never a name from the
 * source: a remote title containing `/` or `..` would otherwise choose where the
 * file lands.
 */
export function buildArgs(input: {
  readonly url: string;
  readonly outputPath: string;
  readonly limits: AcquireLimits;
  /** From {@link chooseFormat}: a bare `id` or `id+id`, validated here. */
  readonly format?: string | null;
  /** The ffmpeg this worker checked at boot (`FFMPEG_PATH`), for the merge. */
  readonly ffmpegPath?: string;
}): string[] {
  const format = input.format ?? FALLBACK_FORMAT;
  const fallback = format === FALLBACK_FORMAT;
  // The selector reaches argv as one entry either way; this keeps it to what
  // `chooseFormat` produces (format ids joined by `+`) or the fixed fallback.
  const ids = format.split("+");
  if (!fallback && (ids.length > 2 || !ids.every((id) => /^[\w-]{1,32}$/.test(id)))) {
    throw new DownloaderUnusableError(
      `refusing an unexpected format selector ${JSON.stringify(format)}`,
    );
  }
  const args = [
    // No terminal, no colours, no progress bar to parse: progress comes from
    // --newline on stdout, which is a format rather than a moving cursor.
    //
    // No --no-warnings either: a warning is how yt-dlp says a client was
    // skipped or formats may be missing, which is the first thing an operator
    // needs when YouTube changes. Warnings go to the operator log, and decide
    // a failure only as a block (see `classify`).
    "--no-colors",
    "--newline",
    ...UTF8_OUTPUT,
    // A playlist URL imports ONE video, and only when it also names one.
    "--no-playlist",
    // Never write next to the binary, never read a config file, never touch the
    // user's home: everything this run needs is on the command line.
    "--ignore-config",
    "--no-cache-dir",
    // Refuse a live stream rather than downloading an unbounded segment feed.
    "--no-live-from-start",
    // A hard byte ceiling the downloader applies itself; the caller checks the
    // real size afterwards as well, because this one is advisory on some sites.
    "--max-filesize",
    `${String(input.limits.maxBytes)}`,
    // One file, merged into a container the existing media pipeline accepts.
    "--merge-output-format",
    "mp4",
    ...ffmpegLocationArgs(input.ffmpegPath),
    "-f",
    format,
    // Exact ids need no order. The fallback leaves the choice to yt-dlp, and
    // only its sort can rank by the short side (see FALLBACK_FORMAT).
    ...(fallback ? ["-S", FALLBACK_SORT] : []),
    // Bounded retries inside one attempt; BullMQ owns the retries between them.
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--socket-timeout",
    "30",
    "-o",
    input.outputPath,
    "--",
    input.url,
  ];
  assertNoForbiddenArgs(args);
  return args;
}

/**
 * `--ffmpeg-location` for a configured path, and nothing for a bare name.
 *
 * The merge has to use the ffmpeg this worker verified at boot, not whichever
 * one happens to be first on PATH. But yt-dlp reads the location as a path and
 * treats one that is not on disk as "no ffmpeg at all" (it warns and continues
 * without it, and then refuses to merge), so the default `ffmpeg` — resolved
 * through PATH by both processes alike — is left for yt-dlp to find itself.
 */
function ffmpegLocationArgs(ffmpegPath: string | undefined): string[] {
  if (ffmpegPath === undefined || !/[\\/]/.test(ffmpegPath)) return [];
  return ["--ffmpeg-location", ffmpegPath];
}

/** The metadata-only argument list: no bytes are fetched. */
export function buildProbeArgs(url: string): string[] {
  const args = [
    // Warnings are kept for the operator log; see `buildArgs`.
    "--no-colors",
    ...UTF8_OUTPUT,
    "--no-playlist",
    "--ignore-config",
    "--no-cache-dir",
    "--skip-download",
    "--dump-single-json",
    "--socket-timeout",
    "30",
    "--",
    url,
  ];
  assertNoForbiddenArgs(args);
  return args;
}

/**
 * Refuse an argument list containing anything on the deny list.
 *
 * Exported because it is the invariant, not an implementation detail: the test
 * suite asserts it against both builders, and any future builder must call it.
 */
export function assertNoForbiddenArgs(args: readonly string[]): void {
  for (const arg of args) {
    const flag = arg.split("=")[0] ?? arg;
    if ((NEVER_ALLOWED_ARGS as readonly string[]).includes(flag)) {
      throw new DownloaderUnusableError(`refusing to run the downloader with ${flag}`);
    }
  }
}

/** The binary's own version string, for health output and the job result. */
export async function ytDlpVersion(binary: string, timeoutMs = 30_000): Promise<string> {
  try {
    const result = await run(binary, ["--version"], { timeoutMs });
    return result.stdout.trim().split("\n")[0]?.trim() ?? "";
  } catch (error) {
    throw new DownloaderUnusableError(
      `could not run ${binary}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** SHA-256 of a file on disk, hex. */
export async function sha256File(path: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the path is the configured binary location, not user input
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Refuse to start unless the downloader is the exact pinned release.
 *
 * Two checks, because they fail differently: the version string catches the
 * ordinary "the image installed something else" mistake with a readable message,
 * and the digest catches the one that matters — a binary that reports the right
 * version and is not the right binary.
 *
 * `verifyDigest` is false only where there is nothing to verify against: a
 * package-manager build (`WORKER_MEDIA_YT_DLP_VERIFY=0`), which is what this
 * product's own host runs. The image passes it true, and with
 * {@link EXPECTED_SHA256} still null that is a refusal to start, which is the
 * correct state until someone records the publisher's digest.
 *
 * The version pin holds with verification off too (ADR 0002 §7), unless
 * `allowUnpinned` says otherwise (`WORKER_MEDIA_YT_DLP_ALLOW_UNPINNED=1`). That
 * is a separate switch because it is a separate trade-off: a package-manager
 * build is updated by its package manager, and a YouTube change is fixed by
 * exactly that update within days, but refusing to boot on it kills the
 * acquisition worker while every health check stays green. Running an
 * unreviewed downloader against user-supplied URLs instead is a decision for
 * the owner of a deployment to make by name — not a side effect of turning the
 * digest check off. With it set, another version is a warning; with the digest
 * being verified it is refused regardless, because no other binary can match.
 */
export async function assertYtDlpUsable(input: {
  readonly binary: string;
  readonly verifyDigest: boolean;
  /** Only with `verifyDigest` false. See above. */
  readonly allowUnpinned?: boolean;
}): Promise<{ readonly version: string; readonly sha256: string | null }> {
  const version = await ytDlpVersion(input.binary);
  if (version === "") {
    // Something ran and printed nothing: whatever it is, it is not yt-dlp.
    throw new DownloaderUnusableError(
      `Cannot start acquisition: ${input.binary} reports no version, so it is not the downloader.`,
    );
  }
  if (version !== EXPECTED_VERSION && !input.verifyDigest && input.allowUnpinned === true) {
    logger.warn("downloader is not the pinned release; continuing, as allowed", {
      tool: "yt-dlp",
      version,
      pinned: EXPECTED_VERSION,
    });
    return { version, sha256: null };
  }
  if (version !== EXPECTED_VERSION) {
    throw new DownloaderUnusableError(
      [
        `Cannot start acquisition: the downloader reports ${version},`,
        `and this build is pinned to ${EXPECTED_VERSION} (ADR 0002 §7).`,
        "",
        "The pin is not advisory. Acquisition runs an executable this repository",
        "does not build, against URLs a user supplies, so the version that runs",
        "has to be the version that was reviewed.",
        ...(input.verifyDigest
          ? []
          : [
              "",
              "For a package-manager build, WORKER_MEDIA_YT_DLP_ALLOW_UNPINNED=1 runs",
              "another version with a warning; that is a decision to make on purpose.",
            ]),
      ].join("\n"),
    );
  }

  if (!input.verifyDigest) return { version, sha256: null };

  if (EXPECTED_SHA256 === null) {
    throw new DownloaderUnusableError(
      [
        "Cannot start acquisition: no SHA-256 has been recorded for the pinned",
        `downloader release ${EXPECTED_VERSION}.`,
        "",
        "Record the digest from the publisher's own checksum file in",
        "`docs/repurposing-platform-master-plan/WAVE-0-FOUNDATION.md` and set",
        "`EXPECTED_SHA256` in `apps/worker-media/src/yt-dlp.ts`. Until then this",
        "worker will not run a downloader it cannot identify.",
      ].join("\n"),
    );
  }

  const actual = await sha256File(input.binary);
  if (actual !== EXPECTED_SHA256) {
    throw new DownloaderUnusableError(
      `Cannot start acquisition: ${input.binary} hashes to ${actual}, not the pinned ${EXPECTED_SHA256}.`,
    );
  }
  return { version, sha256: actual };
}

/**
 * Ask the source what it is, without downloading it.
 *
 * Refuses live streams and anything whose declared duration already exceeds the
 * plan's limit. Both are checked again after the download, because this answer
 * comes from the source.
 */
export async function probeSource(input: {
  readonly binary: string;
  readonly url: string;
  readonly limits: AcquireLimits;
  readonly signal?: AbortSignal;
}): Promise<SourceMetadata> {
  const result = await run(input.binary, buildProbeArgs(input.url), {
    timeoutMs: Math.min(input.limits.timeoutMs, 120_000),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  logWarnings(result.stderr);
  if (result.code !== 0) {
    // stderr only: stdout is the JSON dump, whose description text could say
    // anything ("live stream", "private video") about a video that is neither.
    throw classify(result.stderr, "could not read the source");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw transientFailure("media/acquire_metadata", "the source description was not readable", {
      reason: "media/source_failed",
    });
  }

  // A playlist dump carries `entries`; a single video does not. Refusing here is
  // what makes `--no-playlist` a guarantee rather than a preference.
  if (Array.isArray(parsed["entries"])) {
    throw sourceRefused("media/source_playlist", "that link points to a playlist, not one video");
  }

  const durationSeconds = typeof parsed["duration"] === "number" ? parsed["duration"] : null;
  const liveStatus = parsed["live_status"];
  const choice = Array.isArray(parsed["formats"])
    ? chooseFormat(parsed["formats"] as ProbeFormat[], input.limits, durationSeconds)
    : null;
  const metadata: SourceMetadata = {
    provider: asString(parsed["extractor_key"]) ?? asString(parsed["extractor"]) ?? "unknown",
    sourceId: asString(parsed["id"]),
    title: asString(parsed["title"]),
    channel: asString(parsed["channel"]) ?? asString(parsed["uploader"]),
    durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
    // A premiere that has not started has no picture yet, and a stream that
    // has just ended with no duration is still being processed into a video:
    // both are "live" to the person choosing what to do next (try it after).
    isLive:
      parsed["is_live"] === true ||
      liveStatus === "is_live" ||
      liveStatus === "is_upcoming" ||
      (liveStatus === "post_live" && durationSeconds === null),
    // The size of what will be fetched. The top-level `filesize_approx` is the
    // size of yt-dlp's own default pick (the largest format), which is what
    // refused an 18-minute talk as "larger than your plan" when its 1080p
    // version was a third of the cap.
    approximateBytes:
      choice !== null
        ? choice.bytes
        : typeof parsed["filesize"] === "number"
          ? parsed["filesize"]
          : typeof parsed["filesize_approx"] === "number"
            ? parsed["filesize_approx"]
            : null,
    formatSelector: choice?.selector ?? null,
  };

  assertWithinLimits(metadata, input.limits);
  return metadata;
}

/** The user-facing sentence for a source over the plan's byte cap. */
const TOO_LARGE = "that video is larger than your plan allows";

/** The limit checks, run against metadata before the download and after it. */
export function assertWithinLimits(metadata: SourceMetadata, limits: AcquireLimits): void {
  if (metadata.isLive) {
    throw sourceRefused("media/source_live", "we cannot use a live stream");
  }
  if (metadata.durationMs !== null && metadata.durationMs > limits.maxDurationMs) {
    throw sourceRefused("media/too_long", "that video is longer than your plan allows");
  }
  if (metadata.approximateBytes !== null && metadata.approximateBytes > limits.maxBytes) {
    throw sourceRefused("media/too_large", TOO_LARGE);
  }
}

/** How often the scratch directory is measured while a download runs. */
export const SIZE_CHECK_INTERVAL_MS = 2_000;

/** How long a killed downloader gets to exit before SIGKILL — `run()`'s grace for ffmpeg. */
const KILL_GRACE_MS = 5_000;

/**
 * Downloader lines kept for classifying a failure. Progress lines are not kept:
 * a long download prints thousands, and they would push out the one line that
 * says why it stopped.
 */
const OUTPUT_LINES = 200;

/** A line longer than this is flushed as it stands rather than buffered forever. */
const MAX_LINE_CHARS = 64 * 1024;

/**
 * Download one video to `outputPath`.
 *
 * Returns nothing: what landed is measured by the caller with ffprobe and a
 * checksum, because the only trustworthy description of a file is the file.
 *
 * Three ways this ends without a file, each named rather than left to surface as
 * an `ENOENT` later (which is retryable, and so fetched the whole video three
 * times before saying "failed"):
 *
 * - yt-dlp's own `--max-filesize` abort, which it prints to stdout and then
 *   exits 0 — for a split download it skips the oversize part and never merges;
 * - this function's size watch, which kills the downloader once the bytes on
 *   disk pass the cap (the only cap that holds for a fragmented stream);
 * - any other exit, classified from what the downloader printed.
 */
export async function download(input: {
  readonly binary: string;
  readonly url: string;
  readonly outputPath: string;
  readonly limits: AcquireLimits;
  readonly format?: string | null;
  /** Passed to yt-dlp as `--ffmpeg-location` (see {@link buildArgs}). */
  readonly ffmpegPath?: string;
  readonly onProgress?: (percent: number) => void;
  readonly signal?: AbortSignal;
  /** Tests shorten it; production measures every {@link SIZE_CHECK_INTERVAL_MS}. */
  readonly sizeCheckIntervalMs?: number;
}): Promise<void> {
  const result = await runDownloader(
    input.binary,
    buildArgs({
      url: input.url,
      outputPath: input.outputPath,
      limits: input.limits,
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(input.ffmpegPath === undefined ? {} : { ffmpegPath: input.ffmpegPath }),
    }),
    {
      timeoutMs: input.limits.timeoutMs,
      outputPath: input.outputPath,
      maxBytes: input.limits.maxBytes,
      sizeCheckIntervalMs: input.sizeCheckIntervalMs ?? SIZE_CHECK_INTERVAL_MS,
      onLine: (line) => {
        const percent = parseProgress(line);
        if (percent !== null) input.onProgress?.(percent);
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );
  logWarnings(result.output);

  if (result.code !== 0) {
    throw classify(result.output, "we could not download that video");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a name this module chose, in a directory `withWorkspace` made
  const landed = await stat(input.outputPath).then(
    (facts) => facts.isFile(),
    () => false,
  );
  if (!landed) {
    // Exit 0 and no file: yt-dlp skipped something rather than failing. The
    // reason — nearly always the max-filesize abort — is in what it printed.
    throw classify(
      result.output,
      "the download finished without a file",
      "media/acquire_no_output",
    );
  }
}

interface DownloaderResult {
  readonly code: number;
  /** stdout and stderr lines in arrival order, progress lines left out. Unredacted. */
  readonly output: string;
}

/**
 * Run the downloader, reading BOTH streams line by line, and watch the disk.
 *
 * Not `run()`: that keeps only a stderr tail and gives stdout to nobody until
 * the process exits, and yt-dlp's progress and its size abort are on stdout. The
 * spawn rules are `run()`'s — no shell, a timeout that kills and then kills
 * harder, an abort that kills — and it rejects on the same terms, plus one:
 * writing more than `maxBytes` is a {@link sourceRefused} `media/too_large`.
 */
async function runDownloader(
  binary: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly outputPath: string;
    readonly maxBytes: number;
    readonly sizeCheckIntervalMs: number;
    readonly onLine: (line: string) => void;
    readonly signal?: AbortSignal;
  },
): Promise<DownloaderResult> {
  return new Promise<DownloaderResult>((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(binary, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(
        transientFailure("media/tool_spawn", `could not start ${binary}`, {
          cause: error,
          reason: "media/source_failed",
        }),
      );
      return;
    }

    const kept: string[] = [];
    const keep = (line: string): void => {
      options.onLine(line);
      if (isProgressLine(line)) return;
      kept.push(line);
      if (kept.length > OUTPUT_LINES) kept.shift();
    };
    const stdout = lineReader(keep);
    const stderr = lineReader(keep);
    const output = (): string => kept.join("\n");

    let settled = false;
    let killedBy: "timeout" | "abort" | "oversize" | null = null;
    let measuring = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = (why: "timeout" | "abort" | "oversize"): void => {
      if (killedBy !== null) return;
      killedBy = why;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    timer.unref();

    // The cap that holds whatever the format: `--max-filesize` never fires for
    // a fragmented stream, and for a split download it is per part.
    const watch = setInterval(() => {
      if (measuring || killedBy !== null) return;
      measuring = true;
      void downloadedBytes(options.outputPath)
        .then((bytes) => {
          if (bytes > options.maxBytes) kill("oversize");
        })
        .finally(() => {
          measuring = false;
        });
    }, options.sizeCheckIntervalMs);
    watch.unref();

    const onAbort = (): void => kill("abort");
    if (options.signal?.aborted === true) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));

    child.on("error", (error) => {
      finish(() =>
        reject(
          transientFailure("media/tool_spawn", `${binary} failed to run`, {
            cause: error,
            reason: "media/source_failed",
          }),
        ),
      );
    });

    child.on("close", (code, signal) => {
      stdout.end();
      stderr.end();
      const tail = stderrTail(output());
      if (killedBy === "oversize") {
        finish(() => reject(sourceRefused("media/too_large", TOO_LARGE, tail)));
        return;
      }
      if (killedBy !== null) {
        const timedOut = killedBy === "timeout";
        finish(() =>
          reject(
            transientFailure(
              timedOut ? "media/tool_timeout" : "media/cancelled",
              timedOut
                ? `${binary} exceeded ${String(options.timeoutMs)} ms and was killed`
                : `${binary} was cancelled`,
              { detail: tail, reason: "media/source_failed" },
            ),
          ),
        );
        return;
      }
      if (code === null) {
        finish(() =>
          reject(
            transientFailure("media/tool_signal", `${binary} was killed by ${signal ?? "a signal"}`, {
              detail: tail,
              reason: "media/source_failed",
            }),
          ),
        );
        return;
      }
      finish(() => resolve({ code, output: output() }));
    });
  });
}

/**
 * Bytes the downloader has fetched so far, in the job's own scratch directory.
 *
 * Two kinds of file are left out, because counting them would double a
 * legitimate download and kill it: `*.temp.*` (a merge or fixup writing a
 * second copy of what is already here) and the finished output itself (which
 * sits next to its parts until yt-dlp deletes them). The finished file is
 * measured after the download instead.
 */
async function downloadedBytes(outputPath: string): Promise<number> {
  const dir = dirname(outputPath);
  const finished = basename(outputPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the job's own scratch directory
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === finished || entry.name.includes(".temp.")) continue;
    // A fragment can be appended and deleted between the listing and the stat.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
    total += await stat(join(dir, entry.name)).then(
      (facts) => facts.size,
      () => 0,
    );
  }
  return total;
}

/**
 * Split a stream into lines as it arrives. yt-dlp ends a progress update with
 * `\r` as well as `\n` (its max-filesize line even starts with one), so all
 * three endings count.
 */
function lineReader(onLine: (line: string) => void): {
  push(chunk: string): void;
  end(): void;
} {
  let pending = "";
  const emit = (line: string): void => {
    if (line.trim() !== "") onLine(line);
  };
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r\n|\r|\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
      if (pending.length > MAX_LINE_CHARS) {
        emit(pending);
        pending = "";
      }
    },
    end() {
      emit(pending);
      pending = "";
    },
  };
}

/**
 * The downloader's warnings, for the operator. They never decide a failure and
 * never reach the user; they are how a YouTube change announces itself ("some
 * formats may be missing") before it becomes one.
 */
function logWarnings(output: string): void {
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const warning = line.trim();
    if (!isWarning(warning) || seen.has(warning)) continue;
    seen.add(warning);
    logger.warn("downloader warning", { tool: "yt-dlp", warning: redact(warning).slice(0, 500) });
    if (seen.size >= 10) return;
  }
}

/**
 * The percentage out of a `--newline` progress line, or null.
 *
 * Exported for its test: a downloader that changes its progress format should
 * cost a silent progress bar, never a failed job, so the caller treats null as
 * "no news" rather than an error.
 */
export function parseProgress(chunk: string): number | null {
  // Flat on purpose: no nested quantifier, so there is nothing to backtrack.
  // The line comes from a subprocess, but a pathological regex is a denial of
  // service whoever wrote the input.
  const match = /\[download\] +([\d.]{1,7})%/.exec(chunk);
  if (match === null) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

/**
 * A progress update, with a percentage or — when the server sent no length —
 * just a byte count (`[download]    2.99MiB at 1.02MiB/s`). Neither says why a
 * download stopped, so neither is kept for {@link classify}.
 */
function isProgressLine(line: string): boolean {
  return parseProgress(line) !== null || /^\s*\[download\] +~?[\d.]{1,9}[KMGT]?i?B /.test(line);
}

/** The user-facing sentence for a block, however it was recognised. */
const BLOCKED = "the video site is refusing our requests for now";

/**
 * What the downloader says when it refuses, and what that means for the user.
 *
 * Lower-case phrases, matched against the ERROR lines only (see {@link classify}
 * for the one thing a warning may decide). **Order matters, first match wins**:
 * YouTube's rate-limit error begins "Video unavailable" and its bot check begins
 * "Sign in", so the block has to be recognised before "removed" and "private"
 * are, or a one-hour block against this server reads as a permanent fact about
 * the user's video.
 */
const REFUSALS: readonly {
  readonly reason: MediaFailureReason;
  readonly message: string;
  readonly phrases: readonly string[];
}[] = [
  {
    // Not retried by BullMQ either: a retry five seconds later hits the same
    // block and makes it worse. The run page offers the retry, later.
    reason: "media/source_blocked",
    message: BLOCKED,
    phrases: [
      // "you're" arrives with either apostrophe, or mangled by a code page.
      "not a bot",
      "rate-limited",
      "rate limited",
      "http error 429",
      "too many requests",
      "captcha",
      "try again later",
    ],
  },
  {
    reason: "media/source_age_restricted",
    message: "that video is age-restricted",
    phrases: ["confirm your age", "age-restricted", "age restricted", "inappropriate for some"],
  },
  {
    reason: "media/source_private",
    message: "that video is private or needs a sign-in",
    phrases: [
      "private video",
      "video is private",
      "members-only",
      "members only",
      "join this channel",
      // "…available to this channel's members on level: …", matched without the
      // apostrophe, which a code page can mangle.
      "members on level",
      "granted access",
      "premium members",
      "requires payment",
      "sign in to view",
      "login required",
    ],
  },
  {
    reason: "media/source_live",
    message: "that video is a live stream",
    phrases: ["live event", "live stream", "livestream", "premieres in", "premiere will begin"],
  },
  {
    reason: "media/source_removed",
    message: "that video has been removed or is unavailable",
    phrases: [
      "video unavailable",
      "video is unavailable",
      "no longer available",
      "removed by the uploader",
      "has been removed",
      "has been terminated",
      "does not exist",
      // Blocked where this server is: as permanent, for us, as a removal.
      "available in your country",
      "available from your location",
      "geo restriction",
      "geo-restricted",
    ],
  },
  {
    reason: "media/unsupported",
    message: "that link is not a video we can use",
    phrases: ["unsupported url", "is not a valid url", "incomplete youtube id"],
  },
];

/**
 * The block, as a WARNING says it. Narrower than the block's ERROR phrases:
 * "try again later" in a warning is too loose to stop the retries on. No
 * apostrophes, for the reason `--encoding` is passed (see {@link buildArgs}).
 */
const BLOCK_WARNING_PHRASES = [
  "not a bot",
  "rate-limited",
  "rate limited",
  "http error 429",
  "too many requests",
  "captcha",
] as const;

/**
 * Turn the downloader's output into one of OUR failures.
 *
 * Reads stdout and stderr together, because the size abort is on stdout. The
 * distinction that matters is retryable versus not: a private or deleted video
 * will be just as private next time, and retrying it three times only delays
 * the message the user needs. Everything unrecognised stays retryable, because
 * guessing "permanent" on a transient network fault loses a job, and carries
 * `media/source_failed` for when its retries run out.
 *
 * ERROR lines are the evidence, matched against {@link REFUSALS}; output with
 * no ERROR line at all (a crash) is matched whole, warnings aside. A warning
 * that one client wanted a sign-in is routine while another client succeeds,
 * and must never make a failure "private" or "removed".
 *
 * The one thing a warning can decide is the block, and only when no ERROR line
 * named anything. YouTube often says it per client, as warnings ("Sign in to
 * confirm you're not a bot", a 429), and then yt-dlp gives up with a generic
 * ERROR ("Requested format is not available", "HTTP Error 403"). Retried, that
 * went back to YouTube twice more inside fifteen seconds — the hammering a
 * block is refused to stop. Read as a block, the user is told to try later,
 * which is the right advice for the rare transient fault it mislabels too.
 */
export function classify(
  output: string,
  message: string,
  transientCode = "media/acquire_failed",
): MediaJobError {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  const errors = lines.filter((line) => line.trim().startsWith("ERROR:"));
  const evidence = errors.length > 0 ? errors : lines.filter((line) => !isWarning(line));
  const detail = stderrTail(evidence.join("\n"));

  // Anywhere, on either stream: yt-dlp prints it as a `[download]` line, not
  // an ERROR, and then exits 0.
  if (lines.some((line) => line.toLowerCase().includes("larger than max-filesize"))) {
    return sourceRefused("media/too_large", TOO_LARGE, detail);
  }

  const haystack = evidence.join("\n").toLowerCase();
  const refusal = REFUSALS.find(({ phrases }) =>
    phrases.some((phrase) => haystack.includes(phrase)),
  );
  if (refusal !== undefined) return sourceRefused(refusal.reason, refusal.message, detail);

  const blockWarning = lines.find(
    (line) =>
      isWarning(line) &&
      BLOCK_WARNING_PHRASES.some((phrase) => line.toLowerCase().includes(phrase)),
  );
  if (blockWarning !== undefined) {
    return sourceRefused(
      "media/source_blocked",
      BLOCKED,
      stderrTail([blockWarning, ...evidence].join("\n")),
    );
  }

  return transientFailure(transientCode, message, { detail, reason: "media/source_failed" });
}

function isWarning(line: string): boolean {
  return line.trim().startsWith("WARNING:");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

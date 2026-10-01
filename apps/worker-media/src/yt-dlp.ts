import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";

import {
  type MediaFailureReason,
  type MediaJobError,
  describeError,
  knownFacts,
  redact,
  sourceRefused,
  stderrTail,
  transientFailure,
} from "./errors.js";
import { run } from "./ffmpeg/run.js";
import { logger } from "./logger.js";

import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
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
 * - **Nothing is fetched or loaded that was not installed on purpose.** Every
 *   list clears the JavaScript runtimes and names one (`--no-js-runtimes
 *   --js-runtimes node:<path>`), forbids remote components (the challenge
 *   solver is the pinned `yt-dlp-ejs` package, never scripts from GitHub) and
 *   clears the plugin directories. The boot check reads yt-dlp's own `-v`
 *   header to prove all three took.
 * - **A long source is cut down, not refused.** With a window on the job, only
 *   that part of the video is fetched (`--download-sections`); see
 *   {@link planSection}.
 * - **A stop stops everything the downloader started.** A section is fetched
 *   by an ffmpeg that yt-dlp starts with the worker's own pipes, and on
 *   Windows the launcher stub lets it outlive both the launcher and python.
 *   So a kill takes the whole process tree ({@link killTree}), and the run
 *   ends when the downloader exits, not when the last holder of its pipes
 *   lets go.
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
 * The YouTube challenge solver `yt-dlp[pin]==2026.8.19` installs, and the only
 * one this build runs.
 *
 * yt-dlp checks the solver's script hashes against the version it bundles and
 * silently falls back to a single client on a mismatch — a downloader that
 * still "works" until the day it does not. So the boot check pins it by name,
 * next to {@link EXPECTED_VERSION}, and the two move together.
 */
export const EXPECTED_EJS_VERSION = "0.8.0";

/**
 * Arguments that must never appear, whatever produced them.
 *
 * Checked against the built list rather than the inputs, so a future edit to
 * `buildArgs` cannot reintroduce one by accident. `--exec` and `--downloader` run
 * other programs; `--update` replaces this binary; the config-file flags let a
 * file on disk add arguments this module never wrote. `--remote-components`
 * fetches solver scripts from GitHub at run time — unreviewed code executed on
 * this machine against a URL a user chose (ADR 0002 §7) — and `--plugin-dirs`
 * loads Python from a directory. `--js-runtimes` is allowed exactly once, in
 * the form {@link runtimeArgs} writes it (see {@link assertNoForbiddenArgs}).
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
  "--remote-components",
  "--plugin-dirs",
] as const;

/**
 * Arguments every list must carry, so what yt-dlp runs is what is on the list:
 * no config file, no JavaScript runtime but the named one, nothing fetched,
 * nothing loaded from a plugin directory.
 */
export const REQUIRED_ARGS = [
  "--ignore-config",
  "--no-js-runtimes",
  "--no-remote-components",
  "--no-plugin-dirs",
] as const;

/**
 * The yt-dlp extractors a `hosted_url` (2026-10-01) is held to with
 * `--use-extractors`, by site: Vimeo, Google Drive and Dropbox. yt-dlp matches
 * these against its extractors' lower-cased names in full, so `vimeo` is the
 * one video extractor and never `vimeo:album` or `vimeo:channel`. A YouTube
 * link carries none, exactly as before: its URL check is the boundary there.
 */
export const HOSTED_EXTRACTORS = ["vimeo", "googledrive", "dropbox"] as const;
export type HostedExtractor = (typeof HOSTED_EXTRACTORS)[number];

/**
 * A format id `chooseFormat` may pick and `buildArgs` may pass. YouTube's are
 * a few digits; Vimeo's name the CDN and run longer
 * (`hls-fastly_skyfire-1080p`), so the bound is 64. Nothing outside
 * `[A-Za-z0-9_-]` either way: the id reaches argv as part of one entry.
 */
const FORMAT_ID = /^[\w-]{1,64}$/;

/** The one runtime flag a list may carry, and only after `--no-js-runtimes`. */
const JS_RUNTIMES_FLAG = "--js-runtimes";

/**
 * How much longer than its window a landed file may be: 15 s. A stream copy
 * starts on the keyframe before the cut, so a section is a few seconds longer
 * than asked; anything past this is not the section that was asked for.
 */
export const WINDOW_TOLERANCE_MS = 15_000;

/**
 * A chosen start with less than this after it is moved back to the last full
 * window: ten seconds of a video is not a run.
 */
export const MIN_SECTION_MS = 10_000;

/** The longest section end this module formats: the contract's 24-hour ceiling. */
const MAX_SECTION_END_MS = 86_400_000;

/** Heatmap rows read at most; YouTube sends 100. */
const MAX_HEATMAP_ROWS = 1_000;

export interface AcquireLimits {
  readonly maxBytes: number;
  /**
   * The longest SOURCE this job may fetch. With a window it is the abuse
   * ceiling (12 h), not the plan's allowance: a longer source is cut down to
   * the window instead of refused.
   */
  readonly maxDurationMs: number;
  readonly timeoutMs: number;
}

export type WindowPolicy = "first" | "most_replayed" | "range";

/** `media.acquire` payload `window` (`MediaAcquirePayloadSchema`): how much of a source to take. */
export interface AcquireWindow {
  /** The minutes the plan processes per run. */
  readonly maxMs: number;
  /** The user's chosen start, for `range`. */
  readonly startMs?: number;
  readonly policy: WindowPolicy;
}

/**
 * The part of a source that is fetched, in the SOURCE's own clock, and the
 * policy that actually chose it (`first` when `most_replayed` found no
 * heatmap). Reported as the result's `section`.
 */
export interface SectionPlan {
  readonly startMs: number;
  readonly endMs: number;
  readonly sourceDurationMs: number;
  readonly policy: WindowPolicy;
}

export interface SourceMetadata {
  readonly provider: string;
  readonly sourceId: string | null;
  readonly title: string | null;
  readonly channel: string | null;
  readonly durationMs: number | null;
  readonly isLive: boolean;
  /**
   * Size of what WILL be downloaded (the chosen streams, over the section when
   * there is one), not of the largest format.
   */
  readonly approximateBytes: number | null;
  /**
   * The exact streams to download (`137+140`), chosen by {@link chooseFormat}
   * from the probe's own format list; `null` when the source listed none, and
   * the download falls back to {@link FALLBACK_FORMAT}.
   */
  readonly formatSelector?: string | null;
  /** The part to fetch; `null` or absent when the whole source is. */
  readonly section?: SectionPlan | null;
  /**
   * The streams, and their estimated size, for the WHOLE source — what the
   * fallback fetches when a section download fails ({@link planSection}).
   * Equal to the above when there is no section.
   */
  readonly wholeFormatSelector?: string | null;
  readonly wholeBytes?: number | null;
  /** The centre of YouTube's most-replayed segment, in ms; `null` without a heatmap. */
  readonly replayedPeakMs?: number | null;
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
  const aac = (f: ProbeFormat): number =>
    f.ext === "m4a" || acodecOf(f).startsWith("mp4a") ? 1 : 0;
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
 * `fraction` is the share of the source a section download fetches: every
 * size is scaled by it, so a 20-minute window of a 3-hour talk is budgeted as
 * the 20 minutes it is, and fetched in 4K when those fit where the whole would
 * not.
 *
 * Exported for its tests; the probe is the only caller.
 */
export function chooseFormat(
  formats: readonly ProbeFormat[],
  limits: Pick<AcquireLimits, "maxBytes" | "timeoutMs">,
  durationS: number | null,
  fraction = 1,
): FormatChoice | null {
  const share = Number.isFinite(fraction) && fraction > 0 && fraction < 1 ? fraction : 1;
  const scaled = (bytes: number | null): number | null =>
    bytes === null ? null : Math.round(bytes * share);
  // An id `buildArgs` would refuse is never chosen: the download would fail
  // as "unusable" for a source with a perfectly good format beside it.
  const usable = formats.filter(
    (format) =>
      typeof format.format_id === "string" &&
      FORMAT_ID.test(format.format_id) &&
      format.has_drm !== true,
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
    const videoBytes = scaled(sizeOf(format, durationS));
    if (acodecOf(format) === "none") {
      if (audio === undefined) continue;
      const audioBytes = scaled(sizeOf(audio, durationS));
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

/**
 * The centre of YouTube's most-replayed segment, in ms, from the metadata's
 * `heatmap` (`[{start_time, end_time, value}]`, seconds); `null` when there is
 * none worth reading.
 *
 * It is already in the probe's answer, so choosing by it costs no request.
 * Rows that are not numbers, run backwards or start past the end are skipped
 * rather than trusted; on a tie the earliest segment wins, so the choice is
 * the same every time for the same video.
 */
export function mostReplayedPeakMs(heatmap: unknown, durationMs: number | null): number | null {
  if (!Array.isArray(heatmap)) return null;
  let best: { readonly centreMs: number; readonly value: number } | null = null;
  for (const row of heatmap.slice(0, MAX_HEATMAP_ROWS) as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const { start_time: start, end_time: end, value } = row as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number" || typeof value !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(value)) continue;
    if (start < 0 || end <= start || (durationMs !== null && start * 1000 >= durationMs)) continue;
    if (best === null || value > best.value) {
      best = { centreMs: Math.round(((start + end) / 2) * 1000), value };
    }
  }
  return best?.centreMs ?? null;
}

/**
 * Which part of a source to fetch, or `null` when all of it fits the window.
 *
 * - `range`: from the user's own start. A window that runs off the end is cut
 *   short there rather than moved back over minutes nobody chose — "process
 *   the next 20 minutes" of a 34-minute video is 20:00-34:37, not an overlap —
 *   and only a start with (next to) nothing after it moves back to the last
 *   full window.
 * - `most_replayed`: centred on the most-replayed segment, slid to fit inside
 *   the video. With no heatmap it is `first`, and says so.
 * - `first`: from the start.
 *
 * Every value is a whole millisecond derived from integers, so the section
 * argument built from it is too.
 */
export function planSection(input: {
  readonly durationMs: number;
  readonly window: AcquireWindow;
  readonly replayedPeakMs: number | null;
}): SectionPlan | null {
  const { durationMs, window } = input;
  if (!(durationMs > window.maxMs)) {
    // A start the person picked on a video that fits the window whole: from
    // there to the end, not the whole video from 0:00 (which ignored the pick
    // and charged for the part they skipped). A start with less than a
    // section after it takes the whole video.
    const startMs = window.policy === "range" ? (window.startMs ?? 0) : 0;
    if (startMs <= 0 || startMs + MIN_SECTION_MS > durationMs) return null;
    return { startMs, endMs: durationMs, sourceDurationMs: durationMs, policy: "range" };
  }
  const lastStart = durationMs - window.maxMs;
  let startMs = 0;
  let policy: WindowPolicy = "first";
  if (window.policy === "range" && window.startMs !== undefined) {
    policy = "range";
    startMs = window.startMs + MIN_SECTION_MS > durationMs ? lastStart : window.startMs;
  } else if (window.policy === "most_replayed" && input.replayedPeakMs !== null) {
    policy = "most_replayed";
    startMs = Math.min(Math.max(0, Math.round(input.replayedPeakMs - window.maxMs / 2)), lastStart);
  }
  return {
    startMs,
    endMs: Math.min(startMs + window.maxMs, durationMs),
    sourceDurationMs: durationMs,
    policy,
  };
}

/** Milliseconds as the seconds yt-dlp and ffmpeg read (`1234.500`), from a checked integer. */
export function formatSeconds(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_SECTION_END_MS) {
    throw new DownloaderUnusableError(`refusing an unexpected time ${JSON.stringify(ms)}`);
  }
  return (ms / 1000).toFixed(3);
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
 *
 * A `section` becomes `--download-sections *S-E`, from two integers
 * {@link planSection} derived and {@link formatSeconds} checks. yt-dlp hands a
 * section to ffmpeg's own reader: no percentage progress (the caller measures
 * the bytes on disk instead) and no `--max-filesize` (the size watch is the
 * cap, as it already is for fragmented streams). There is deliberately no
 * `--force-keyframes-at-cuts`: that re-encodes, and a copy that starts on the
 * keyframe a few seconds early is harmless.
 */
export function buildArgs(input: {
  readonly url: string;
  readonly outputPath: string;
  readonly limits: AcquireLimits;
  /** From {@link chooseFormat}: a bare `id` or `id+id`, validated here. */
  readonly format?: string | null;
  /** The ffmpeg this worker checked at boot (`FFMPEG_PATH`), for the merge. */
  readonly ffmpegPath?: string;
  /** `YT_DLP_JS_RUNTIME`: an absolute path to node, or none. */
  readonly jsRuntime?: string;
  /** Only this part of the source (see {@link planSection}). */
  readonly section?: Pick<SectionPlan, "startMs" | "endMs"> | null;
  /** A hosted link's one extractor (see {@link HOSTED_EXTRACTORS}). */
  readonly extractor?: HostedExtractor;
}): string[] {
  const format = input.format ?? FALLBACK_FORMAT;
  const fallback = format === FALLBACK_FORMAT;
  // The selector reaches argv as one entry either way; this keeps it to what
  // `chooseFormat` produces (format ids joined by `+`) or the fixed fallback.
  const ids = format.split("+");
  if (!fallback && (ids.length > 2 || !ids.every((id) => FORMAT_ID.test(id)))) {
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
    ...runtimeArgs(input.jsRuntime),
    ...extractorArgs(input.extractor),
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
    ...sectionArgs(input.section ?? null),
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
  assertSafeArgs(args);
  return args;
}

/**
 * The JavaScript runtime, the remote components and the plugins, locked.
 *
 * `--no-js-runtimes` first, so a deno installed later cannot quietly become
 * the runtime YouTube's scripts run in, then the one node this deployment
 * named. `--no-remote-components` because the solver is the pinned
 * `yt-dlp-ejs` package, never scripts fetched from GitHub at run time.
 * `--no-plugin-dirs` because a plugin is Python loaded from a directory.
 */
export function runtimeArgs(jsRuntime: string | undefined): string[] {
  return [
    "--no-js-runtimes",
    ...(jsRuntime === undefined || jsRuntime === "" ? [] : [JS_RUNTIMES_FLAG, `node:${jsRuntime}`]),
    "--no-remote-components",
    "--no-plugin-dirs",
  ];
}

/**
 * `--use-extractors <name>` for a hosted link, and nothing for YouTube.
 *
 * The point is what it leaves out: yt-dlp's generic extractor, which reads
 * any page it is given and follows wherever that page points. With only the
 * site's own extractor allowed, a link it does not claim is an "unsupported
 * URL" and nothing is fetched. The name is checked against the closed list
 * here as well as by the type, because the list is the invariant.
 */
export function extractorArgs(extractor: HostedExtractor | undefined): string[] {
  if (extractor === undefined) return [];
  if (!(HOSTED_EXTRACTORS as readonly string[]).includes(extractor)) {
    throw new DownloaderUnusableError(`refusing the extractor ${JSON.stringify(extractor)}`);
  }
  return ["--use-extractors", extractor];
}

function sectionArgs(section: Pick<SectionPlan, "startMs" | "endMs"> | null): string[] {
  if (section === null) return [];
  if (!(section.endMs > section.startMs)) {
    throw new DownloaderUnusableError(`refusing an empty section ${JSON.stringify(section)}`);
  }
  return [
    "--download-sections",
    `*${formatSeconds(section.startMs)}-${formatSeconds(section.endMs)}`,
  ];
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
export function buildProbeArgs(
  url: string,
  options: { readonly jsRuntime?: string; readonly extractor?: HostedExtractor } = {},
): string[] {
  const args = [
    // Warnings are kept for the operator log; see `buildArgs`.
    "--no-colors",
    ...UTF8_OUTPUT,
    "--no-playlist",
    "--ignore-config",
    "--no-cache-dir",
    // The metadata step is where YouTube's challenges are solved, so it needs
    // the runtime at least as much as the download does.
    ...runtimeArgs(options.jsRuntime),
    ...extractorArgs(options.extractor),
    "--skip-download",
    "--dump-single-json",
    "--socket-timeout",
    "30",
    "--",
    url,
  ];
  assertSafeArgs(args);
  return args;
}

/**
 * The boot check's argument list: `-v` and the same lock-down as a real run,
 * and no URL, so nothing is fetched. yt-dlp prints its debug header (version,
 * optional libraries, JS runtimes, plugin directories) and then exits 2 for
 * the missing URL. No `--no-colors` here: with no URL after it, yt-dlp reads
 * that exact 11-character flag as a video id and warns about it.
 */
export function buildHeaderArgs(jsRuntime: string | undefined): string[] {
  const args = [
    "-v",
    ...UTF8_OUTPUT,
    "--ignore-config",
    "--no-cache-dir",
    ...runtimeArgs(jsRuntime),
  ];
  assertSafeArgs(args);
  return args;
}

/** Both invariants: nothing forbidden in the list, and everything required in it. */
function assertSafeArgs(args: readonly string[]): void {
  assertNoForbiddenArgs(args);
  assertLockedDown(args);
}

/**
 * Refuse an argument list containing anything on the deny list.
 *
 * Exported because it is the invariant, not an implementation detail: the test
 * suite asserts it against every builder, and any future builder must call it.
 *
 * `--js-runtimes` is the one flag that is allowed in exactly one form: once,
 * as its own entry, after `--no-js-runtimes`, followed by `node:` and an
 * absolute path. Anything else — a second runtime, `deno`, a bare `node` that
 * PATH would resolve, the `--flag=value` spelling — is a runtime this module
 * did not choose.
 */
export function assertNoForbiddenArgs(args: readonly string[]): void {
  let runtimes = 0;
  args.forEach((arg, index) => {
    const flag = arg.split("=")[0] ?? arg;
    if ((NEVER_ALLOWED_ARGS as readonly string[]).includes(flag)) {
      throw new DownloaderUnusableError(`refusing to run the downloader with ${flag}`);
    }
    if (flag !== JS_RUNTIMES_FLAG) return;
    runtimes += 1;
    const value = args.at(index + 1) ?? "";
    if (
      arg !== JS_RUNTIMES_FLAG ||
      runtimes > 1 ||
      !args.slice(0, index).includes("--no-js-runtimes") ||
      !isNodeRuntime(value)
    ) {
      throw new DownloaderUnusableError(
        `refusing to run the downloader with ${flag} ${JSON.stringify(value)}`,
      );
    }
  });
}

/**
 * Refuse a list without the lock-down ({@link REQUIRED_ARGS}), or with it only
 * after `--`, where yt-dlp would read it as a URL.
 */
export function assertLockedDown(args: readonly string[]): void {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  for (const required of REQUIRED_ARGS) {
    if (!options.includes(required)) {
      throw new DownloaderUnusableError(`refusing to run the downloader without ${required}`);
    }
  }
}

function isNodeRuntime(value: string): boolean {
  if (!value.startsWith("node:")) return false;
  const path = value.slice("node:".length);
  return path !== "" && !path.includes("\0") && (win32.isAbsolute(path) || posix.isAbsolute(path));
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
 *
 * Then yt-dlp describes itself (`-v`, offline, the same lock-down as a real
 * run; see {@link assertDownloaderHeader}): with `jsRuntime` set it must report
 * that node runtime and the pinned `yt-dlp-ejs`, and whatever is set it must
 * load no plugins.
 */
export async function assertYtDlpUsable(input: {
  readonly binary: string;
  readonly verifyDigest: boolean;
  /** Only with `verifyDigest` false. See above. */
  readonly allowUnpinned?: boolean;
  /** `YT_DLP_JS_RUNTIME`. */
  readonly jsRuntime?: string;
}): Promise<DownloaderIdentity> {
  const version = await ytDlpVersion(input.binary);
  if (version === "") {
    // Something ran and printed nothing: whatever it is, it is not yt-dlp.
    throw new DownloaderUnusableError(
      `Cannot start acquisition: ${input.binary} reports no version, so it is not the downloader.`,
    );
  }
  const unpinnedAllowed = !input.verifyDigest && input.allowUnpinned === true;
  if (version !== EXPECTED_VERSION && unpinnedAllowed) {
    logger.warn("downloader is not the pinned release; continuing, as allowed", {
      tool: "yt-dlp",
      version,
      pinned: EXPECTED_VERSION,
    });
    return { version, sha256: null, ...(await describeDownloader(input, unpinnedAllowed)) };
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

  if (!input.verifyDigest) {
    return { version, sha256: null, ...(await describeDownloader(input, unpinnedAllowed)) };
  }

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
  return { version, sha256: actual, ...(await describeDownloader(input, unpinnedAllowed)) };
}

/** What the boot check proved about the downloader, for the boot log. */
export interface DownloaderIdentity {
  readonly version: string;
  readonly sha256: string | null;
  /** `yt-dlp-ejs`, the challenge solver; `null` when it is not installed. */
  readonly ejsVersion: string | null;
  /** `node-24.19.0` as yt-dlp reports it; `null` when no runtime is enabled. */
  readonly jsRuntime: string | null;
}

/** yt-dlp's own `-v` header, as far as the boot check reads it. */
export interface DownloaderHeader {
  /** `2026.08.19` out of `yt-dlp version stable@2026.08.19 from …`. */
  readonly version: string | null;
  /** Out of "Optional libraries"; `null` when yt-dlp-ejs is not installed. */
  readonly ejsVersion: string | null;
  /** The "JS runtimes" line as printed (`node-24.19.0`, `none (disabled)`). */
  readonly jsRuntimes: string | null;
  /** The node runtime yt-dlp found and will use; `null` when it found none. */
  readonly nodeVersion: string | null;
  /** yt-dlp's own verdict that that node is too old for its solver. */
  readonly nodeUnsupported: boolean;
  /** The "Plugin directories" line; only `none…` is acceptable. */
  readonly pluginDirectories: string | null;
  /** "Extractor Plugins" / "Post-Processor Plugins" lines: plugins that loaded. */
  readonly plugins: readonly string[];
}

/**
 * Read yt-dlp's debug header. Line by line with fixed prefixes rather than
 * one pattern over the whole output: the header is short, and a line that
 * changes shape should cost a clear refusal, never a wrong match.
 *
 * Exported for its tests.
 */
export function readDownloaderHeader(output: string): DownloaderHeader {
  let version: string | null = null;
  let ejsVersion: string | null = null;
  let jsRuntimes: string | null = null;
  let pluginDirectories: string | null = null;
  const plugins: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("[debug] ")) continue;
    const body = line.slice("[debug] ".length);
    const field = (label: string): string | null =>
      body.startsWith(`${label}: `) ? body.slice(label.length + 2).trim() : null;

    if (body.startsWith("yt-dlp version ")) {
      // `yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp [594bd50c2] (pip)`
      const token = body.slice("yt-dlp version ".length).split(" ")[0] ?? "";
      version = (token.includes("@") ? token.split("@")[1] : token) || null;
      continue;
    }
    const libraries = field("Optional libraries");
    if (libraries !== null) {
      const ejs = libraries
        .split(",")
        .map((library) => library.trim())
        .find((library) => library.startsWith("yt_dlp_ejs-"));
      ejsVersion = ejs === undefined ? null : ejs.slice("yt_dlp_ejs-".length) || null;
      continue;
    }
    jsRuntimes = field("JS runtimes") ?? jsRuntimes;
    pluginDirectories = field("Plugin directories") ?? pluginDirectories;
    if (body.startsWith("Extractor Plugins: ") || body.startsWith("Post-Processor Plugins: ")) {
      plugins.push(body);
    }
  }

  let nodeVersion: string | null = null;
  let nodeUnsupported = false;
  for (const entry of (jsRuntimes ?? "").split(",")) {
    const runtime = entry.trim();
    if (!runtime.startsWith("node-")) continue;
    const [versionPart, ...rest] = runtime.slice("node-".length).split(" ");
    nodeVersion = versionPart === undefined || versionPart === "" ? null : versionPart;
    nodeUnsupported = rest.join(" ").includes("unsupported");
  }
  return {
    version,
    ejsVersion,
    jsRuntimes,
    nodeVersion,
    nodeUnsupported,
    pluginDirectories,
    plugins,
  };
}

/**
 * Refuse a downloader whose own header shows it will not run as configured.
 *
 * - No header at all: whatever answered `-v`, it is not the reviewed yt-dlp.
 * - A plugin loaded, or plugin directories searched: Python this repository
 *   never saw would run inside every extraction.
 * - `jsRuntime` set, and no node in the header: the path is wrong or node will
 *   not start, and YouTube quietly falls back to one client. Or node too old
 *   for the solver, which yt-dlp itself says.
 * - `jsRuntime` set, and no `yt-dlp-ejs`, or not the pinned one: node would
 *   have no solver to run, or one whose hashes yt-dlp rejects. Another version
 *   is a warning only where another yt-dlp is ({@link assertYtDlpUsable}'s
 *   `allowUnpinned`), because the two ship together.
 */
export function assertDownloaderHeader(
  header: DownloaderHeader,
  options: { readonly jsRuntime?: string; readonly unpinnedAllowed?: boolean },
): void {
  const refuse: (why: string) => never = (why) => {
    throw new DownloaderUnusableError(`Cannot start acquisition: ${why}`);
  };
  if (header.version === null) {
    refuse("the downloader printed no debug header for -v, so it is not the reviewed yt-dlp.");
  }
  if (header.plugins.length > 0 || !(header.pluginDirectories ?? "").startsWith("none")) {
    refuse(
      `the downloader loads plugins (${[header.pluginDirectories ?? "no plugin line", ...header.plugins].join("; ")}), ` +
        "and --no-plugin-dirs is meant to leave it none.",
    );
  }
  if (options.jsRuntime === undefined || options.jsRuntime === "") return;
  if (header.nodeVersion === null) {
    refuse(
      `YT_DLP_JS_RUNTIME names ${options.jsRuntime}, but yt-dlp reports "JS runtimes: ${header.jsRuntimes ?? "(no line)"}". ` +
        "Check that the path is node and that it runs.",
    );
  }
  if (header.nodeUnsupported) {
    refuse(
      `yt-dlp reports node ${String(header.nodeVersion)} as too old for its challenge solver.`,
    );
  }
  if (header.ejsVersion === null) {
    refuse(
      "yt-dlp-ejs is not installed next to the downloader, so node has no challenge solver to run. " +
        `Install yt-dlp[pin]==${EXPECTED_VERSION} (it pins yt-dlp-ejs==${EXPECTED_EJS_VERSION}).`,
    );
  }
  if (header.ejsVersion !== EXPECTED_EJS_VERSION) {
    if (options.unpinnedAllowed !== true) {
      refuse(
        `yt-dlp-ejs is ${String(header.ejsVersion)}, and this build is pinned to ${EXPECTED_EJS_VERSION}.`,
      );
    }
    logger.warn("challenge solver is not the pinned release; continuing, as allowed", {
      tool: "yt-dlp-ejs",
      version: header.ejsVersion,
      pinned: EXPECTED_EJS_VERSION,
    });
  }
}

/**
 * How much of each stream {@link captureOutput} keeps, from the START: 64 KiB.
 * The header is about 2 KB.
 */
const CAPTURE_MAX_CHARS = 64 * 1024;

/**
 * Run a short command and keep what it printed, both streams, in full up to
 * {@link CAPTURE_MAX_CHARS} each.
 *
 * Not `run()`, which keeps only the last twelve lines of stderr: the pinned
 * venv prints fourteen header lines there, the version line exactly twelfth
 * from the end, so one more line of any kind — a WARNING, a deprecation
 * notice, a new debug line in a later release — pushed the version out, and
 * the worker refused to boot for "no debug header". Resolves for any exit
 * code (the header check exits 2, on purpose); rejects when the command could
 * not start or ran past `timeoutMs`.
 */
async function captureOutput(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(binary, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child, "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`no answer within ${String(timeoutMs)} ms`));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < CAPTURE_MAX_CHARS)
        stdout += chunk.slice(0, CAPTURE_MAX_CHARS - stdout.length);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < CAPTURE_MAX_CHARS)
        stderr += chunk.slice(0, CAPTURE_MAX_CHARS - stderr.length);
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Run the header check and say what it proved. */
async function describeDownloader(
  input: { readonly binary: string; readonly jsRuntime?: string },
  unpinnedAllowed: boolean,
): Promise<Pick<DownloaderIdentity, "ejsVersion" | "jsRuntime">> {
  let output: string;
  try {
    // Exits 2 for the missing URL, on purpose: the header is what is wanted.
    const result = await captureOutput(input.binary, buildHeaderArgs(input.jsRuntime), 30_000);
    output = `${result.stderr}\n${result.stdout}`;
  } catch (error) {
    throw new DownloaderUnusableError(
      `could not run ${input.binary} -v: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const header = readDownloaderHeader(output);
  assertDownloaderHeader(header, {
    ...(input.jsRuntime === undefined ? {} : { jsRuntime: input.jsRuntime }),
    unpinnedAllowed,
  });
  if (input.jsRuntime === undefined || input.jsRuntime === "") {
    logger.warn(
      "no JavaScript runtime for the downloader (YT_DLP_JS_RUNTIME); YouTube falls back to one client",
      { tool: "yt-dlp", jsRuntimes: header.jsRuntimes, ejs: header.ejsVersion },
    );
  }
  return {
    ejsVersion: header.ejsVersion,
    jsRuntime: header.nodeVersion === null ? null : `node-${header.nodeVersion}`,
  };
}

/**
 * Ask the source what it is, without downloading it.
 *
 * Refuses live streams and anything whose declared duration already exceeds the
 * plan's limit. Both are checked again after the download, because this answer
 * comes from the source.
 *
 * With a `window`, a source longer than it is planned as a section
 * ({@link planSection}): the formats are chosen for the section's share of
 * the bytes, `approximateBytes` is the section's, and the whole source's
 * choice is kept for the fallback. `limits.maxDurationMs` is then the source
 * ceiling, so a long video is cut down rather than refused.
 */
export async function probeSource(input: {
  readonly binary: string;
  readonly url: string;
  readonly limits: AcquireLimits;
  readonly signal?: AbortSignal;
  readonly jsRuntime?: string;
  readonly window?: AcquireWindow;
  /** A hosted link's one extractor; absent for YouTube. */
  readonly extractor?: HostedExtractor;
}): Promise<SourceMetadata> {
  const result = await run(
    input.binary,
    buildProbeArgs(input.url, {
      ...(input.jsRuntime === undefined ? {} : { jsRuntime: input.jsRuntime }),
      ...(input.extractor === undefined ? {} : { extractor: input.extractor }),
    }),
    {
      timeoutMs: Math.min(input.limits.timeoutMs, 120_000),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );

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

  const durationSeconds =
    typeof parsed["duration"] === "number" &&
    Number.isFinite(parsed["duration"]) &&
    parsed["duration"] > 0
      ? parsed["duration"]
      : null;
  const durationMs = durationSeconds === null ? null : Math.round(durationSeconds * 1000);
  const liveStatus = parsed["live_status"];
  // Only YouTube publishes a most-replayed heatmap; on another site
  // (2026-10-01) a field of that name is not one.
  const replayedPeakMs =
    input.extractor === undefined ? mostReplayedPeakMs(parsed["heatmap"], durationMs) : null;
  const section =
    input.window === undefined || durationMs === null
      ? null
      : planSection({ durationMs, window: input.window, replayedPeakMs });
  const fraction =
    section === null ? 1 : (section.endMs - section.startMs) / section.sourceDurationMs;
  const formats = Array.isArray(parsed["formats"]) ? (parsed["formats"] as ProbeFormat[]) : null;
  const choice =
    formats === null ? null : chooseFormat(formats, input.limits, durationSeconds, fraction);
  const whole =
    section === null || formats === null
      ? choice
      : chooseFormat(formats, input.limits, durationSeconds);
  // yt-dlp's own estimate, of its own default pick, when the formats gave none.
  const listed =
    typeof parsed["filesize"] === "number"
      ? parsed["filesize"]
      : typeof parsed["filesize_approx"] === "number"
        ? parsed["filesize_approx"]
        : null;
  const metadata: SourceMetadata = {
    provider: asString(parsed["extractor_key"]) ?? asString(parsed["extractor"]) ?? "unknown",
    sourceId: asString(parsed["id"]),
    title: asString(parsed["title"]),
    channel: asString(parsed["channel"]) ?? asString(parsed["uploader"]),
    durationMs,
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
      choice !== null ? choice.bytes : listed === null ? null : Math.round(listed * fraction),
    formatSelector: choice?.selector ?? null,
    section,
    wholeFormatSelector: whole?.selector ?? null,
    wholeBytes: whole !== null ? whole.bytes : listed,
    replayedPeakMs,
  };

  assertWithinLimits(metadata, input.limits);
  return metadata;
}

/** The user-facing sentence for a source over the plan's byte cap. */
const TOO_LARGE = "that video is larger than your plan allows";

/**
 * The limit checks, run against metadata before the download and after it.
 *
 * Every limit refusal carries its numbers (`facts`), as far as they are known,
 * so the page can say "34:37 — your plan takes 20:00" rather than only "too
 * long".
 */
export function assertWithinLimits(metadata: SourceMetadata, limits: AcquireLimits): void {
  const facts = knownFacts({
    durationMs: metadata.durationMs,
    maxDurationMs: limits.maxDurationMs,
    approximateBytes: metadata.approximateBytes,
    maxBytes: limits.maxBytes,
  });
  if (metadata.isLive) {
    throw sourceRefused("media/source_live", "we cannot use a live stream");
  }
  if (metadata.durationMs !== null && metadata.durationMs > limits.maxDurationMs) {
    throw sourceRefused(
      "media/too_long",
      "that video is longer than your plan allows",
      undefined,
      facts,
    );
  }
  if (metadata.approximateBytes !== null && metadata.approximateBytes > limits.maxBytes) {
    throw sourceRefused("media/too_large", TOO_LARGE, undefined, facts);
  }
}

/** How often the scratch directory is measured while a download runs. */
export const SIZE_CHECK_INTERVAL_MS = 2_000;

/** How long a killed downloader gets to exit before SIGKILL — `run()`'s grace for ffmpeg. */
const KILL_GRACE_MS = 5_000;

/**
 * How long the pipes may stay open after the downloader has exited before the
 * run ends without them. Normally they close with it; see {@link killTree}
 * for what holds them when they do not.
 */
export const DRAIN_GRACE_MS = 2_000;

/**
 * Downloader lines kept for classifying a failure. Progress lines are not kept:
 * a long download prints thousands, and they would push out the one line that
 * says why it stopped.
 */
const OUTPUT_LINES = 200;

/** A line longer than this is flushed as it stands rather than buffered forever. */
const MAX_LINE_CHARS = 64 * 1024;

/**
 * How fast a section must arrive, as a multiple of its own running time: 2x.
 *
 * A section goes through ffmpeg's own HTTP reader, which YouTube may throttle
 * towards real time, while the whole file comes in yt-dlp's 10 MiB chunks at
 * the connection's speed. Below 2x, fetching the whole video and cutting it
 * here is the faster road — when the whole video fits the plan.
 */
export const SECTION_MIN_REALTIME = 2;

/** ffmpeg's head start: opening two streams and seeking both. Not counted against the pace. */
export const PACE_STARTUP_MS = 15_000;

/**
 * How long a section runs before its pace is judged from what has landed.
 * Earlier than this, one slow seek reads as a slow download.
 */
export const PACE_WARMUP_MS = 60_000;

/** How a section download is held to {@link SECTION_MIN_REALTIME}. */
export interface DownloadPace {
  /** The section's running time. */
  readonly mediaMs: number;
  /**
   * The section's estimated size, for when ffmpeg has printed no `time=`;
   * `null` then leaves only the deadline.
   */
  readonly expectedBytes: number | null;
  readonly minRealtime: number;
  /** Tests shorten these; production uses {@link PACE_STARTUP_MS} and {@link PACE_WARMUP_MS}. */
  readonly startupMs?: number;
  readonly warmupMs?: number;
}

/** How far a section download has got. */
export interface DownloadLanded {
  /** The most bytes seen on disk so far — never less, so a rename cannot read as a stall. */
  readonly bytes: number;
  /** ffmpeg's own `time=`: the media time written so far; `null` before it has said. */
  readonly mediaMs: number | null;
}

/**
 * True when a section download is running slower than its pace allows.
 *
 * `elapsedMs` runs from the moment the download itself began — yt-dlp's
 * `[download] Destination:` line, or the first bytes on disk — not from the
 * spawn: extraction, and with node YouTube's challenge solving, can take tens
 * of seconds, and a short section's whole allowance is less than that.
 *
 * Two tests. The deadline: the section's running time over the pace, plus the
 * head start — twenty minutes of video in ten minutes and fifteen seconds.
 * And, once past the warm-up, what has landed against the time spent since
 * the head start. That is ffmpeg's own `time=`, the exact media time written,
 * when it has printed one; the bytes on disk against the estimate only when
 * it has not, because the estimate is the video's AVERAGE bitrate and a quiet
 * stretch below it would read as a slow one. The second test is the one that
 * saves time: a reader throttled to real time is known after a minute, not
 * after ten. A section that has all of its media is never slow.
 *
 * Exported for its tests.
 */
export function isTooSlow(pace: DownloadPace, landed: DownloadLanded, elapsedMs: number): boolean {
  const startupMs = pace.startupMs ?? PACE_STARTUP_MS;
  const landedMediaMs =
    landed.mediaMs ??
    (pace.expectedBytes === null || pace.expectedBytes <= 0
      ? null
      : Math.min(1, landed.bytes / pace.expectedBytes) * pace.mediaMs);
  if (landedMediaMs !== null && landedMediaMs >= pace.mediaMs) return false;
  if (elapsedMs > pace.mediaMs / pace.minRealtime + startupMs) return true;
  if (landedMediaMs === null || elapsedMs < (pace.warmupMs ?? PACE_WARMUP_MS)) return false;
  return landedMediaMs < (elapsedMs - startupMs) * pace.minRealtime;
}

/**
 * The media time out of one of ffmpeg's stats lines
 * (`frame= 7220 fps=… size=  81920KiB time=00:04:00.66 bitrate=… speed=2.1x`),
 * in ms; `null` for any other line, and for `time=N/A`.
 *
 * Under a section download ffmpeg writes these to the worker's own stderr
 * (yt-dlp starts it with inherited pipes), a few times a second. Flat on
 * purpose, like {@link parseProgress}.
 *
 * Exported for its tests.
 */
export function parseMediaTime(line: string): number | null {
  if (!isFfmpegStats(line)) return null;
  const match = /\btime=(\d{1,3}):(\d{2}):(\d{2}\.?\d{0,3})/.exec(line);
  if (match === null) return null;
  const [, hours, minutes, seconds] = match;
  const total = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return Number.isFinite(total) ? Math.round(total) : null;
}

/** An ffmpeg stats line: progress, like yt-dlp's percentages, and as useless for saying why it stopped. */
function isFfmpegStats(line: string): boolean {
  return /^\s*(?:frame|size)=/.test(line) && line.includes("time=");
}

/**
 * Kill a process and everything it started.
 *
 * The downloader is not one process. On Windows `YT_DLP_PATH` is a pip
 * launcher stub that runs python, and for a section python runs ffmpeg with
 * plain `Popen(args, stdin=PIPE)` — so ffmpeg inherits the worker's stdout and
 * stderr. Killing the stub (all `child.kill()` can reach) takes python with it
 * through the stub's job object, but ffmpeg breaks away from that job and
 * lives on: it keeps fetching, keeps the pipes open so the run never ends, and
 * keeps its file open so the scratch directory cannot be removed. Measured on
 * the production host with the pinned 2026.8.19 venv: the stub gone at 15 s,
 * ffmpeg still fetching 45 s later.
 *
 * - **Windows:** `taskkill /PID <pid> /T /F`, which walks the tree by parent
 *   pid — so it runs while the stub is still alive, before anything has been
 *   orphaned. `taskkill.exe` is named by path, never found on PATH.
 * - **Elsewhere:** the downloader is spawned as its own process group
 *   (`detached`), and the group is signalled.
 *
 * Anything that fails falls back to `child.kill()`. A process that has
 * already exited is left alone: its pid may be someone else's by now.
 *
 * Exported for its tests.
 */
export function killTree(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    execFile(
      taskkillPath(),
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 10_000 },
      (error) => {
        if (error !== null) child.kill(signal);
      },
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function taskkillPath(): string {
  return win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
}

/**
 * After the downloader has exited with its pipes still held: on POSIX, what is
 * left of its process group. (On Windows nothing is left to find by then, and
 * a kill of the whole tree happened while it could.)
 */
function killRemnants(pid: number | undefined, platform: NodeJS.Platform = process.platform): void {
  if (pid === undefined || platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Nothing left in the group, which is the usual case.
  }
}

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
 *
 * A `section` download adds a fourth: running slower than its `pace`
 * ({@link isTooSlow}) is a retryable `media/acquire_slow`, which the caller
 * answers by fetching the whole file instead. Its progress comes from
 * `onBytes`, because ffmpeg's reader prints no percentage.
 *
 * And any download stops, as a retryable `media/disk_full`, once `lowDisk`
 * says the scratch volume is below its reserve: the database is next to fill.
 */
export async function download(input: {
  readonly binary: string;
  readonly url: string;
  readonly outputPath: string;
  readonly limits: AcquireLimits;
  readonly format?: string | null;
  /** Passed to yt-dlp as `--ffmpeg-location` (see {@link buildArgs}). */
  readonly ffmpegPath?: string;
  /** `YT_DLP_JS_RUNTIME` (see {@link runtimeArgs}). */
  readonly jsRuntime?: string;
  /** Only this part of the source. */
  readonly section?: Pick<SectionPlan, "startMs" | "endMs"> | null;
  /** A hosted link's one extractor (see {@link extractorArgs}); absent for YouTube. */
  readonly extractor?: HostedExtractor;
  /** Kill a download that runs slower than this; see {@link isTooSlow}. */
  readonly pace?: DownloadPace;
  readonly onProgress?: (percent: number) => void;
  /** The bytes on disk, every size check. */
  readonly onBytes?: (bytes: number) => void;
  /** Asked every size check: true stops the download (see `DiskGuard.belowReserve`). */
  readonly lowDisk?: () => Promise<boolean>;
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
      ...(input.jsRuntime === undefined ? {} : { jsRuntime: input.jsRuntime }),
      ...(input.section === undefined ? {} : { section: input.section }),
      ...(input.extractor === undefined ? {} : { extractor: input.extractor }),
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
      ...(input.onBytes === undefined ? {} : { onBytes: input.onBytes }),
      ...(input.pace === undefined ? {} : { pace: input.pace }),
      ...(input.lowDisk === undefined ? {} : { lowDisk: input.lowDisk }),
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

export interface DownloaderResult {
  readonly code: number;
  /** stdout and stderr lines in arrival order, progress lines left out. Unredacted. */
  readonly output: string;
}

type KillReason = "timeout" | "abort" | "oversize" | "slow" | "disk";

/**
 * Run the downloader, reading BOTH streams line by line, and watch the disk.
 *
 * Not `run()`: that keeps only a stderr tail and gives stdout to nobody until
 * the process exits, and yt-dlp's progress and its size abort are on stdout. The
 * spawn rules are `run()`'s — no shell, a timeout that kills and then kills
 * harder, an abort that kills — and it rejects on the same terms, plus one:
 * writing more than `maxBytes` is a {@link sourceRefused} `media/too_large`.
 *
 * Two rules `run()` does not need, because of the ffmpeg a section download
 * runs with this process's own pipes: every kill is of the whole tree
 * ({@link killTree}), and the run ends {@link DRAIN_GRACE_MS} after the
 * downloader EXITS whether or not its pipes have closed. Waiting for the
 * pipes alone meant waiting for that ffmpeg — through a stop, a timeout, a
 * size cap and the pace rule alike.
 *
 * Exported for its tests, which run real processes.
 */
export async function runDownloader(
  binary: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly outputPath: string;
    readonly maxBytes: number;
    readonly sizeCheckIntervalMs: number;
    readonly onLine: (line: string) => void;
    readonly onBytes?: (bytes: number) => void;
    readonly pace?: DownloadPace;
    readonly lowDisk?: () => Promise<boolean>;
    readonly signal?: AbortSignal;
    /** Tests shorten it. */
    readonly drainGraceMs?: number;
  },
): Promise<DownloaderResult> {
  return new Promise<DownloaderResult>((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(binary, [...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a kill reaches what it starts (killTree).
        // Not on Windows, where `detached` means a console of its own instead.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(
        transientFailure("media/tool_spawn", `could not start ${binary}`, {
          cause: error,
          reason: "media/source_failed",
        }),
      );
      return;
    }

    // When the download itself began: the pace is judged from here, not from
    // the spawn (see `isTooSlow`).
    let paceFrom: number | null = null;
    // ffmpeg's own `time=`, under a section download.
    let mediaMs: number | null = null;

    const kept: string[] = [];
    const keep = (line: string): void => {
      options.onLine(line);
      if (paceFrom === null && line.includes("[download] Destination:")) paceFrom = Date.now();
      const time = parseMediaTime(line);
      if (time !== null) mediaMs = Math.max(mediaMs ?? 0, time);
      if (isProgressLine(line) || isFfmpegStats(line)) return;
      kept.push(line);
      if (kept.length > OUTPUT_LINES) kept.shift();
    };
    const stdout = lineReader(keep);
    const stderr = lineReader(keep);
    const output = (): string => kept.join("\n");

    let settled = false;
    let exited = false;
    let killedBy: KillReason | null = null;
    let measuring = false;
    let lastBytes = 0;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = (why: KillReason): void => {
      if (killedBy !== null || settled) return;
      killedBy = why;
      if (exited) return;
      killTree(child, "SIGTERM");
      setTimeout(() => {
        if (!exited) killTree(child, "SIGKILL");
      }, KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    timer.unref();

    // The cap that holds whatever the format: `--max-filesize` never fires for
    // a fragmented stream, and for a split download it is per part. For a
    // section, the same measurement is its progress and, with ffmpeg's
    // `time=`, its pace. And the volume: a download stops before the database
    // on the same disk has nowhere left to write.
    const measure = async (): Promise<void> => {
      const { bytes, finished } = await downloadedBytes(options.outputPath);
      if (killedBy !== null || settled) return;
      // The running maximum: once yt-dlp renames `source.mp4.part` to
      // `source.mp4` the parts read as nothing, for the tens of milliseconds
      // before it exits, and a pace judged on that killed finished sections.
      lastBytes = Math.max(lastBytes, bytes);
      if (bytes > options.maxBytes) {
        kill("oversize");
        return;
      }
      options.onBytes?.(bytes);
      if (options.lowDisk !== undefined && (await options.lowDisk())) {
        kill("disk");
        return;
      }
      if (paceFrom === null && lastBytes > 0) paceFrom = Date.now();
      if (
        options.pace !== undefined &&
        !finished &&
        paceFrom !== null &&
        isTooSlow(options.pace, { bytes: lastBytes, mediaMs }, Date.now() - paceFrom)
      ) {
        kill("slow");
      }
    };
    const watch = setInterval(() => {
      if (measuring || killedBy !== null) return;
      measuring = true;
      void measure()
        .catch((error: unknown) => {
          logger.warn("could not measure the download", { error: describeError(error) });
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

    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      stdout.end();
      stderr.end();
      const tail = stderrTail(output());
      if (killedBy === "oversize") {
        finish(() =>
          reject(
            sourceRefused(
              "media/too_large",
              TOO_LARGE,
              tail,
              knownFacts({ approximateBytes: lastBytes, maxBytes: options.maxBytes }),
            ),
          ),
        );
        return;
      }
      if (killedBy === "slow") {
        const pace = options.pace;
        finish(() =>
          reject(
            transientFailure(
              "media/acquire_slow",
              `the section arrived slower than ${String(pace?.minRealtime ?? SECTION_MIN_REALTIME)}x its running time`,
              { detail: tail, reason: "media/source_failed" },
            ),
          ),
        );
        return;
      }
      if (killedBy === "disk") {
        finish(() =>
          reject(
            transientFailure(
              "media/disk_full",
              "the download was stopped: the scratch disk is nearly full",
              { detail: tail, reason: "media/source_failed" },
            ),
          ),
        );
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
            transientFailure(
              "media/tool_signal",
              `${binary} was killed by ${signal ?? "a signal"}`,
              {
                detail: tail,
                reason: "media/source_failed",
              },
            ),
          ),
        );
        return;
      }
      finish(() => resolve({ code, output: output() }));
    };

    child.on("exit", (code, signal) => {
      exited = true;
      // 'close' normally follows at once, when the pipes close. Something the
      // downloader started can hold them open after it has gone (see
      // killTree); give its last lines a moment, then end without it.
      setTimeout(() => {
        if (settled) return;
        killRemnants(child.pid);
        child.stdout.destroy();
        child.stderr.destroy();
        settle(code, signal);
      }, options.drainGraceMs ?? DRAIN_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      settle(code, signal);
    });
  });
}

/**
 * Bytes the downloader has fetched so far, in the job's own scratch directory,
 * and whether the finished file is there yet.
 *
 * Two kinds of file are left out of the bytes, because counting them would
 * double a legitimate download and kill it: `*.temp.*` (a merge or fixup
 * writing a second copy of what is already here) and the finished output
 * itself (which sits next to its parts until yt-dlp deletes them). The
 * finished file is measured after the download instead.
 */
async function downloadedBytes(
  outputPath: string,
): Promise<{ readonly bytes: number; readonly finished: boolean }> {
  const dir = dirname(outputPath);
  const finishedName = basename(outputPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the job's own scratch directory
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  let finished = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === finishedName) {
      finished = true;
      continue;
    }
    if (entry.name.includes(".temp.")) continue;
    // A fragment can be appended and deleted between the listing and the stat.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
    total += await stat(join(dir, entry.name)).then(
      (facts) => facts.size,
      () => 0,
    );
  }
  return { bytes: total, finished };
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
      // Vimeo, Google Drive and Dropbox (2026-10-01): a password, or a file
      // shared only with named people.
      "password protected",
      "protected by a password",
      "video password",
      "you need access",
      "do not have permission",
      "don't have permission",
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
 * The block, as ffmpeg's HTTP reader says it: `[https @ 0x…] HTTP error 429
 * Too Many Requests`. Only these two — a 403 from the reader is as often an
 * expired stream URL as a refusal, and the whole-file download may still get
 * it.
 */
const READER_BLOCK_PHRASES = ["http error 429", "too many requests"] as const;

/** A line from ffmpeg's network layer, which a section download prints into our stderr. */
function isReaderLine(line: string): boolean {
  return /^\s*\[(?:https?|tls|tcp) @ /i.test(line);
}

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
 *
 * ffmpeg's own lines are the other exception. A section is fetched by ffmpeg's
 * reader, and yt-dlp's only ERROR is then `ffmpeg exited with code 1`; the
 * reason is in what ffmpeg printed before it. A 429 there is the same block,
 * and read as an unnamed failure it sent the caller off to fetch the whole
 * video — another extraction and download from the address being refused.
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
  // an ERROR, and then exits 0. It states both numbers, which the page wants.
  const oversize = lines.find((line) => line.toLowerCase().includes("larger than max-filesize"));
  if (oversize !== undefined) {
    const sizes = /\((\d{1,15}) bytes > (\d{1,15}) bytes\)/.exec(oversize);
    return sourceRefused(
      "media/too_large",
      TOO_LARGE,
      detail,
      sizes === null
        ? undefined
        : knownFacts({ approximateBytes: Number(sizes[1]), maxBytes: Number(sizes[2]) }),
    );
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

  const readerBlock = lines.find(
    (line) =>
      isReaderLine(line) &&
      READER_BLOCK_PHRASES.some((phrase) => line.toLowerCase().includes(phrase)),
  );
  if (readerBlock !== undefined) {
    return sourceRefused(
      "media/source_blocked",
      BLOCKED,
      stderrTail([readerBlock, ...evidence].join("\n")),
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

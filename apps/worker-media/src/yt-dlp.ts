import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { type MediaJobError, redact, stderrTail, transientFailure, unreadableMedia } from "./errors.js";
import { run } from "./ffmpeg/run.js";

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
 *   ADR 0002 §7 names, and `assertYtDlpUsable` refuses to start against anything
 *   else. A downloader that updates itself at container boot is an unreviewed
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
 * - **Every limit is enforced twice** — once against the metadata, once against
 *   what actually landed. A source can lie about its duration, and a server can
 *   keep sending bytes after `--max-filesize`.
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

/**
 * The tallest picture worth fetching. Every output this product makes is at
 * most 1080 px on its short side (a 9:16 clip is 1080 x 1920 cut from the
 * middle of the frame), so a 4K source costs 3x the bytes, a slower download
 * and a heavier decode for pixels the export throws away - and, on a long
 * video, blows the plan's byte cap: an 18-minute talk is 556 MB in 4K AV1 and
 * 187 MB in 1080p H.264 (2026-09-25, the failure that prompted this).
 */
export const MAX_SOURCE_HEIGHT = 1080;

/** The shortest picture worth making a clip from, when the source offers better. */
export const MIN_SOURCE_HEIGHT = 360;

/** Estimates are estimates: leave room under the cap for what actually lands. */
const BUDGET_HEADROOM = 0.9;

/** When the source lists no usable formats: the same preferences, as a selector. */
export const FALLBACK_FORMAT =
  `bv*[height<=${String(MAX_SOURCE_HEIGHT)}][vcodec^=avc1]+ba[ext=m4a]/` +
  `bv*[height<=${String(MAX_SOURCE_HEIGHT)}]+ba/b[height<=${String(MAX_SOURCE_HEIGHT)}]/b`;

/** One entry of the probe's `formats` array, as far as the chooser reads it. */
export interface ProbeFormat {
  readonly format_id?: unknown;
  readonly vcodec?: unknown;
  readonly acodec?: unknown;
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
  readonly height: number | null;
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
 * Pick the streams to download: the tallest picture at or under
 * {@link MAX_SOURCE_HEIGHT} whose video and audio together fit the plan's
 * byte budget, preferring H.264 (cheapest to decode downstream) over VP9 over
 * AV1, a direct HTTPS stream over HLS, and the original audio track over a
 * dub. A long video steps down to 720p or 480p rather than failing. When
 * nothing fits, the smallest option is returned so the limit check refuses it
 * with the real reason. Sizes come from the source, or from the bitrate; a
 * source that gives neither gets its best stream, and the byte cap still
 * applies during and after the download.
 *
 * Exported for its tests; the probe is the only caller.
 */
export function chooseFormat(
  formats: readonly ProbeFormat[],
  maxBytes: number,
  durationS: number | null,
): FormatChoice | null {
  const usable = formats.filter(
    (format) => typeof format.format_id === "string" && format.has_drm !== true,
  );
  const audio = pickAudio(usable);

  const candidates: (FormatChoice & { readonly rank: number; readonly hls: boolean })[] = [];
  for (const format of usable) {
    const height = heightOf(format);
    if (vcodecOf(format) === "none" || height === null || height > MAX_SOURCE_HEIGHT) continue;
    const videoBytes = sizeOf(format, durationS);
    if (acodecOf(format) === "none") {
      if (audio === undefined) continue;
      const audioBytes = sizeOf(audio, durationS);
      candidates.push({
        selector: `${String(format.format_id)}+${String(audio.format_id)}`,
        height,
        bytes: videoBytes === null || audioBytes === null ? null : videoBytes + audioBytes,
        rank: codecRank(vcodecOf(format)),
        hls: isHls(format),
      });
    } else {
      candidates.push({
        selector: String(format.format_id),
        height,
        bytes: videoBytes,
        rank: codecRank(vcodecOf(format)),
        hls: isHls(format),
      });
    }
  }
  if (candidates.length === 0) return null;
  // A clip cut from a postage stamp is not a clip. Below the floor only when the
  // source itself has nothing taller.
  const watchable = candidates.filter((candidate) => (candidate.height ?? 0) >= MIN_SOURCE_HEIGHT);
  const pool = watchable.length > 0 ? watchable : candidates;

  pool.sort(
    (a, b) =>
      (b.height ?? 0) - (a.height ?? 0) ||
      a.rank - b.rank ||
      Number(a.bytes === null) - Number(b.bytes === null) ||
      Number(a.hls) - Number(b.hls) ||
      (a.bytes ?? 0) - (b.bytes ?? 0),
  );
  const budget = maxBytes * BUDGET_HEADROOM;
  const sized = pool.filter((candidate) => candidate.bytes !== null);
  // Decide on known sizes whenever there are any: a size-unknown stream at a
  // height whose known-size sibling is over the cap is over the cap too.
  const chosen =
    sized.length > 0
      ? (sized.find((candidate) => (candidate.bytes ?? 0) <= budget) ??
        [...sized].sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0))[0])
      : pool[0];
  if (chosen === undefined) return null;
  return { selector: chosen.selector, height: chosen.height, bytes: chosen.bytes };
}

/** Thrown at boot when the pinned downloader is absent, wrong or unverified. */
export class DownloaderUnusableError extends Error {
  public override readonly name = "DownloaderUnusableError";
}

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
}): string[] {
  const format = input.format ?? FALLBACK_FORMAT;
  // The selector reaches argv as one entry either way; this keeps it to what
  // `chooseFormat` produces (format ids joined by `+`) or the fixed fallback.
  const ids = format.split("+");
  if (
    format !== FALLBACK_FORMAT &&
    (ids.length > 2 || !ids.every((id) => /^[\w-]{1,32}$/.test(id)))
  ) {
    throw new DownloaderUnusableError(
      `refusing an unexpected format selector ${JSON.stringify(format)}`,
    );
  }
  const args = [
    // No terminal, no colours, no progress bar to parse: progress comes from
    // --newline on stderr, which is a format rather than a moving cursor.
    "--no-colors",
    "--newline",
    "--no-warnings",
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
    "-f",
    format,
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

/** The metadata-only argument list: no bytes are fetched. */
export function buildProbeArgs(url: string): string[] {
  const args = [
    "--no-colors",
    "--no-warnings",
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
 * developer machine with a package-manager build. Production passes it true, and
 * with {@link EXPECTED_SHA256} still null that is a refusal to start, which is
 * the correct state until someone records the publisher's digest.
 */
export async function assertYtDlpUsable(input: {
  readonly binary: string;
  readonly verifyDigest: boolean;
}): Promise<{ readonly version: string; readonly sha256: string | null }> {
  const version = await ytDlpVersion(input.binary);
  if (version !== EXPECTED_VERSION) {
    throw new DownloaderUnusableError(
      [
        `Cannot start acquisition: the downloader reports ${version || "no version"},`,
        `and this build is pinned to ${EXPECTED_VERSION} (ADR 0002 §7).`,
        "",
        "The pin is not advisory. Acquisition runs an executable this repository",
        "does not build, against URLs a user supplies, so the version that runs",
        "has to be the version that was reviewed.",
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

  if (result.code !== 0) {
    throw classify(result.stderr, "could not read the source");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw transientFailure("media/acquire_metadata", "the source description was not readable");
  }

  // A playlist dump carries `entries`; a single video does not. Refusing here is
  // what makes `--no-playlist` a guarantee rather than a preference.
  if (Array.isArray(parsed["entries"])) {
    throw unreadableMedia("that link points to a playlist, not one video", "media/unsupported");
  }

  const durationSeconds = typeof parsed["duration"] === "number" ? parsed["duration"] : null;
  const choice = Array.isArray(parsed["formats"])
    ? chooseFormat(parsed["formats"] as ProbeFormat[], input.limits.maxBytes, durationSeconds)
    : null;
  const metadata: SourceMetadata = {
    provider: asString(parsed["extractor_key"]) ?? asString(parsed["extractor"]) ?? "unknown",
    sourceId: asString(parsed["id"]),
    title: asString(parsed["title"]),
    channel: asString(parsed["channel"]) ?? asString(parsed["uploader"]),
    durationMs: durationSeconds === null ? null : Math.round(durationSeconds * 1000),
    isLive: parsed["is_live"] === true || parsed["live_status"] === "is_live",
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

/** The limit checks, run against metadata before the download and after it. */
export function assertWithinLimits(metadata: SourceMetadata, limits: AcquireLimits): void {
  if (metadata.isLive) {
    throw unreadableMedia("we cannot use a live stream", "media/unsupported");
  }
  if (metadata.durationMs !== null && metadata.durationMs > limits.maxDurationMs) {
    throw unreadableMedia("that video is longer than your plan allows", "media/too_long");
  }
  if (metadata.approximateBytes !== null && metadata.approximateBytes > limits.maxBytes) {
    throw unreadableMedia("that video is larger than your plan allows", "media/unsupported");
  }
}

/**
 * Download one video to `outputPath`.
 *
 * Returns nothing: what landed is measured by the caller with ffprobe and a
 * checksum, because the only trustworthy description of a file is the file.
 */
export async function download(input: {
  readonly binary: string;
  readonly url: string;
  readonly outputPath: string;
  readonly limits: AcquireLimits;
  readonly format?: string | null;
  readonly onProgress?: (percent: number) => void;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const result = await run(
    input.binary,
    buildArgs({
      url: input.url,
      outputPath: input.outputPath,
      limits: input.limits,
      ...(input.format === undefined ? {} : { format: input.format }),
    }),
    {
      timeoutMs: input.limits.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onProgress === undefined
        ? {}
        : {
            onStderr: (chunk: string) => {
              const percent = parseProgress(chunk);
              if (percent !== null) input.onProgress?.(percent);
            },
          }),
    },
  );

  if (result.code !== 0) {
    throw classify(result.stderr, "we could not download that video");
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
 * Turn the downloader's stderr into one of OUR failures.
 *
 * The distinction that matters is retryable versus not: a private or deleted
 * video will be just as private next time, and retrying it three times only
 * delays the message the user needs. Everything unrecognised stays retryable,
 * because guessing "permanent" on a transient network fault loses a job.
 */
export function classify(stderr: string, message: string): MediaJobError {
  const tail = stderrTail(stderr);
  const haystack = tail.toLowerCase();
  const permanent = [
    "private video",
    "video unavailable",
    "this video is unavailable",
    "removed by the uploader",
    "account associated with this video has been terminated",
    "sign in to confirm your age",
    "age-restricted",
    "members-only",
    "is not a valid url",
    "unsupported url",
  ];
  if (permanent.some((phrase) => haystack.includes(phrase))) {
    return unreadableMedia(message, "media/unsupported", tail);
  }
  if (haystack.includes("file is larger than max-filesize")) {
    return unreadableMedia("that video is larger than your plan allows", "media/unsupported", tail);
  }
  return transientFailure("media/acquire_failed", message, { detail: redact(tail) });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

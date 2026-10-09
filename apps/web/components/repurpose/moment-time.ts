/**
 * Times in the source video, as a person types and reads them.
 *
 * "Add a moment by time" takes `m:ss` or `h:mm:ss` — the form every video
 * player shows — and checks it against the same limits the API enforces
 * (`ManualCandidateRequestSchema`: 3 s to 3 min, inside the video), so a typo
 * is caught at the field rather than as a refused request.
 */

/** The shortest and longest moment a clip can be cut from (the contract's bounds). */
export const MOMENT_MIN_MS = 3_000;
export const MOMENT_MAX_MS = 180_000;

/** `m:ss` for a position in the source video; `h:mm:ss` past the hour. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${ss}`
    : `${String(minutes)}:${ss}`;
}

/** `mm:ss.mmm` for frame-accurate trimming; `hh:mm:ss.mmm` past the hour. */
export function formatClockMs(ms: number): string {
  const clampedMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(clampedMs / 1000);
  const millis = clampedMs % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${mm}:${ss}.${mmm}`
    : `${mm}:${ss}.${mmm}`;
}

/**
 * `m:ss`, `h:mm:ss`, `mm:ss.mmm`, or `h:mm:ss.mmm` (also a bare minute count
 * over 59, as people type "75:30") to milliseconds, or `null` when it is
 * none of these. Seconds and a minutes field after an hour must be two digits
 * under 60, so "1:5" is refused rather than guessed at.
 */
export function parseClock(raw: string): number | null {
  const match =
    /^\s*(?:(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?|(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?)\s*$/.exec(
      raw,
    );
  if (match === null) return null;
  const [, h, hm, hs, hFrac, m, s, mFrac] = match;
  const hours = h === undefined ? 0 : Number(h);
  const minutes = h === undefined ? Number(m) : Number(hm);
  const seconds = h === undefined ? Number(s) : Number(hs);
  if (seconds > 59 || (h !== undefined && minutes > 59)) return null;
  const fracRaw = h === undefined ? mFrac : hFrac;
  const millis = fracRaw === undefined ? 0 : Number(fracRaw.padEnd(3, "0"));
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

export interface MomentProblems {
  readonly start?: string;
  readonly end?: string;
}

export interface MomentRange {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Everything wrong with a typed start and end, or the range they describe.
 *
 * `durationMs` is the source video's length when the page knows it; without it
 * the API's own check is the only one on the upper end.
 */
export function validateMoment(
  start: string,
  end: string,
  durationMs: number | null | undefined,
): { readonly problems: MomentProblems; readonly range?: MomentRange } {
  const startMs = parseClock(start);
  const endMs = parseClock(end);
  const problems: { start?: string; end?: string } = {};
  if (startMs === null) problems.start = "Type the start as m:ss, like 1:05.";
  if (endMs === null) problems.end = "Type the end as m:ss, like 1:40.";
  if (startMs === null || endMs === null) return { problems };

  const known = durationMs !== null && durationMs !== undefined && durationMs > 0;
  if (known && startMs >= durationMs) {
    problems.start = `The video is only ${formatClock(durationMs)} long.`;
  } else if (endMs <= startMs) {
    problems.end = "The end has to come after the start.";
  } else if (endMs - startMs < MOMENT_MIN_MS) {
    problems.end = "A moment has to be at least 3 seconds long.";
  } else if (endMs - startMs > MOMENT_MAX_MS) {
    problems.end = "A moment can be at most 3 minutes long.";
  } else if (known && endMs > durationMs) {
    problems.end = `The video ends at ${formatClock(durationMs)}.`;
  }
  return Object.keys(problems).length > 0 ? { problems } : { problems, range: { startMs, endMs } };
}

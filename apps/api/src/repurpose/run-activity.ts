import { progressForStatus } from "./repurpose.projection.js";

import type { $Enums } from "@prisma/client";

/**
 * What a run is doing right now, one step at a time, with numbers a person can
 * trust (2026-09-29).
 *
 * The owner's report that started this: a run said "5% complete" while its
 * 5 GB YouTube download was at 67%. The run-level bar was a fixed number per
 * status (`progressForStatus`), so a download of any length sat at 5% from
 * its first byte to its last. The worker had been reporting the download's
 * real progress all along (`jobs.progress`, and a `job.progress` event per
 * report); nothing read it.
 *
 * So this reads it. Pure, like `repurpose.projection.ts`: the reader
 * (`run-activity.reader.ts`) gathers the facts from durable state — the step's
 * newest job and its progress reports, the clips and their videos and images
 * — and everything a person is told is decided here, where it is tested:
 *
 *   * **the step**: its label, how far THIS step is, what that means in units
 *     ("3.1 of 5.0 GB", "clip 3 of 10", "video 12 of 40"), and its place in
 *     the queue when it is waiting behind other people's work;
 *   * **an honest time left**: from the rate the step has actually been
 *     moving at, and only when that rate can be measured and is recent. A
 *     step that has gone quiet, or has not moved long enough to time, gets no
 *     estimate rather than a made-up one;
 *   * **the run's bar**: every step's share of the whole ({@link STEP_WEIGHTS})
 *     filled by how far it has got, so a long download moves it.
 *
 * Nothing technical leaks here either: no queue, no worker, no job
 * (`FORBIDDEN_USER_FACING_WORDS`, asserted in `run-activity.test.ts`).
 */

export const ACTIVITY_STEPS = [
  "queued",
  "downloading",
  "preparing",
  "transcribing",
  "finding",
  "cutting",
  "captioning",
  "formats",
  "images",
  "done",
  "waiting",
] as const;
export type ActivityStep = (typeof ACTIVITY_STEPS)[number];

/** The `activity` object on a run's view. */
export interface RunActivity {
  readonly step: ActivityStep;
  /** One short sentence, present tense: "Downloading your video". */
  readonly label: string;
  /** How far THIS step is, 0-100, when that can be measured. */
  readonly percent?: number;
  /** The step in units: "3.1 of 5.0 GB", "clip 3 of 10", "2 ahead of you". */
  readonly detail?: string;
  /** Seconds this step still needs, only when the rate it has moved at says so. */
  readonly etaSeconds?: number;
  /** Other people's work ahead of this step in line, while it waits for a turn. */
  readonly queuePosition?: number;
}

/**
 * How much of a run's bar each step fills: roughly its share of the time on
 * this machine for a 20-minute window of a YouTube video on Autopilot, where
 * the captioned videos and the other sizes are the long part. A step a run
 * does not take is left out and the rest share the bar (an upload has no
 * download; a run without Autopilot has no captioned videos, sizes or images).
 */
export const STEP_WEIGHTS = Object.freeze({
  downloading: 15,
  preparing: 7,
  transcribing: 18,
  finding: 5,
  cutting: 15,
  captioning: 15,
  formats: 20,
  images: 5,
});
export type Phase = keyof typeof STEP_WEIGHTS;

/**
 * Where the bar stops for a run whose person picks the moments: its last step
 * here is theirs (review, approve, publish), which keeps the coarse numbers
 * `progressForStatus` always gave them (review 85, approved 90, published 100).
 */
const MANUAL_BAR_END = progressForStatus("review_ready");

/**
 * The span of `media.acquire`'s own progress that is the download: the worker
 * reports 2-5% while it checks the video, 5-70% while it downloads, and
 * 75-95% while it checks, keeps and saves the file (`processors/acquire.ts`).
 */
const DOWNLOAD_FROM = 5;
const DOWNLOAD_TO = 70;

/** How far back the rate of a step is measured. */
export const RATE_WINDOW_MS = 10 * 60_000;
/** The least time a rate is measured over; less is noise. */
export const MIN_RATE_SPAN_MS = 20_000;
/**
 * A report older than this means the step has gone quiet: the media workers
 * report at least every 200 s even when nothing moves (a third of a 10-minute
 * lock), so two missed reports are a stall, and a stall has no time left.
 */
export const STALE_SAMPLE_MS = 7 * 60_000;
/** Longer than this is not a time anyone plans around; it is left unsaid. */
export const MAX_ETA_SECONDS = 12 * 60 * 60;
/** How many recent finishes a throughput is measured over. */
const THROUGHPUT_SAMPLE = 8;

/** One `job.progress` report: when, how far, and a download's bytes. */
export interface ProgressSample {
  readonly at: number;
  readonly progress: number;
  readonly bytesDone?: number;
  readonly bytesTotal?: number;
}

/** The newest job of a step, as much as the activity needs. */
export interface StepJob {
  readonly status: $Enums.JobStatus;
  readonly progress: number;
  /** The worker's own estimate of the time left, when it sends one. */
  readonly etaMs: number | null;
  /** Its progress reports, oldest first. */
  readonly samples: readonly ProgressSample[];
  /** Jobs of its type queued before it, in every workspace; null unless it is queued. */
  readonly ahead: number | null;
  /** Held back for want of disk on the media machine (`diskHeldSince`). */
  readonly heldForDisk: boolean;
}

/** When a kind of work finished, and how long each took, for a throughput. */
export interface Finishes {
  readonly at: readonly number[];
  readonly durationsMs: readonly number[];
}

/** A run's clips, counted the way the clip list shows them (`clipStateOf`). */
export interface ClipsProgress {
  readonly total: number;
  readonly ready: number;
  readonly cutting: number;
  readonly waiting: number;
  readonly failed: number;
  /** Ready clips whose own video is prepared, so the editor opens them. */
  readonly usable: number;
  /** Autopilot: each ready clip's captioned 9:16 video. */
  readonly captioned: { readonly ready: number; readonly settled: number };
  /** Autopilot: each ready clip's other three shapes, cut and captioned. */
  readonly formats: { readonly total: number; readonly settled: number };
  /** Autopilot: each ready clip's image set. */
  readonly images: { readonly total: number; readonly settled: number };
  readonly finished: {
    readonly cuts: Finishes;
    readonly captioned: Finishes;
    readonly formats: Finishes;
    readonly images: Finishes;
  };
  /**
   * Below the disk floor (`FORMATS_MIN_FREE_BYTES`): the other shapes and the
   * images wait for room. The 9:16 clips never do.
   */
  readonly lowDisk: boolean;
}

export interface RunActivityFacts {
  readonly now: number;
  /** The status the person sees: the observed one while the early stages lag. */
  readonly status: $Enums.RepurposeRunStatus;
  readonly automation: "auto" | "manual";
  readonly sourceKind: $Enums.RepurposeSourceKind;
  readonly candidateCount: number;
  /** YouTube is refusing this server, and the run fetches again at this time. */
  readonly sourceBusyUntil: number | null;
  /** The source's newest primary media. */
  readonly media: { readonly status: $Enums.MediaStatus; readonly arrived: boolean } | null;
  readonly download: StepJob | null;
  readonly preparation: StepJob | null;
  readonly transcription: StepJob | null;
  readonly discovery: StepJob | null;
  /** Null before the run has moments. */
  readonly clips: ClipsProgress | null;
}

export interface ActivityResult {
  readonly activity: RunActivity | null;
  /** The run's bar, 0-100; null to keep the status's own number. */
  readonly progress: number | null;
}

const NONE: ActivityResult = { activity: null, progress: null };

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function percentOf(fraction: number): number {
  return Math.floor(clamp01(fraction) * 100);
}

/** The steps a run takes, in order. */
export function phasesOf(run: {
  readonly sourceKind: $Enums.RepurposeSourceKind;
  readonly automation: "auto" | "manual";
}): Phase[] {
  const phases: Phase[] = [];
  if (run.sourceKind !== "upload") phases.push("downloading");
  phases.push("preparing", "transcribing", "finding", "cutting");
  if (run.automation === "auto") phases.push("captioning", "formats", "images");
  return phases;
}

/**
 * The run's bar from how far each of its steps is (0-1 each; a step not in
 * `fractions` counts as not started). Steps are weighted by
 * {@link STEP_WEIGHTS}, and the bar ends at 100 for Autopilot and at the
 * review's 85 otherwise.
 */
export function overallProgress(
  phases: readonly Phase[],
  fractions: Partial<Record<Phase, number>>,
  automation: "auto" | "manual",
): number {
  const end = automation === "auto" ? 100 : MANUAL_BAR_END;
  let total = 0;
  let done = 0;
  for (const phase of phases) {
    // eslint-disable-next-line security/detect-object-injection -- a Phase literal from phasesOf
    const weight = STEP_WEIGHTS[phase];
    total += weight;
    // eslint-disable-next-line security/detect-object-injection -- as above
    done += weight * clamp01(fractions[phase] ?? 0);
  }
  if (total === 0) return 0;
  return Math.min(end, Math.floor((done / total) * end));
}

/** Every step before `phase` done, `phase` at `fraction`. */
function upTo(
  phases: readonly Phase[],
  phase: Phase,
  fraction: number,
): Partial<Record<Phase, number>> {
  const fractions: Partial<Record<Phase, number>> = {};
  for (const each of phases) {
    if (each === phase) {
      // eslint-disable-next-line security/detect-object-injection -- a Phase literal
      fractions[each] = fraction;
      break;
    }
    // eslint-disable-next-line security/detect-object-injection -- a Phase literal
    fractions[each] = 1;
  }
  return fractions;
}

/**
 * Seconds left for a quantity moving toward `target`, from the rate its
 * samples say it has moved at over the last {@link RATE_WINDOW_MS}: measured
 * from the oldest sample in that window that is below the newest, over at
 * least {@link MIN_RATE_SPAN_MS}, and only while the newest is recent.
 * Undefined whenever any of that is not true — no estimate beats a wrong one.
 */
export function etaFromRate(
  points: readonly { readonly at: number; readonly value: number }[],
  target: number,
  now: number,
): number | undefined {
  const last = points.at(-1);
  if (last === undefined || now - last.at > STALE_SAMPLE_MS || last.value >= target) {
    return undefined;
  }
  const from = points.find(
    (point) => last.at - point.at <= RATE_WINDOW_MS && point.value < last.value,
  );
  if (from === undefined) return undefined;
  const spanMs = last.at - from.at;
  if (spanMs < MIN_RATE_SPAN_MS) return undefined;
  const perMs = (last.value - from.value) / spanMs;
  const leftMs = (target - last.value) / perMs - (now - last.at);
  if (!Number.isFinite(leftMs) || leftMs <= 0) return undefined;
  const seconds = Math.ceil(leftMs / 1000);
  return seconds > MAX_ETA_SECONDS ? undefined : seconds;
}

/**
 * Seconds left for `remaining` more items of work that finish one after
 * another: the average gap between the recent finishes (which is what the
 * machine actually managed, running two at a time or one), or with a single
 * finish so far its own duration. Undefined with nothing finished to go by,
 * or when the last finish is so long ago that the line has stalled.
 */
export function etaFromThroughput(
  finishes: Finishes,
  remaining: number,
  now: number,
): number | undefined {
  if (remaining <= 0) return undefined;
  const done = [...finishes.at].sort((a, b) => a - b).slice(-THROUGHPUT_SAMPLE);
  let perItemMs: number | undefined;
  const first = done[0];
  const last = done.at(-1);
  if (done.length >= 2 && first !== undefined && last !== undefined && last > first) {
    perItemMs = (last - first) / (done.length - 1);
  } else if (finishes.durationsMs.length > 0) {
    const durations = finishes.durationsMs.slice(-THROUGHPUT_SAMPLE);
    perItemMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  }
  if (perItemMs === undefined || !(perItemMs > 0)) return undefined;
  const sinceLast = last === undefined ? 0 : now - last;
  // Three items' worth of silence (and at least a quarter of an hour) is a
  // line that has stopped, not a slow one.
  if (last !== undefined && sinceLast > Math.max(3 * perItemMs, 15 * 60_000)) return undefined;
  const leftMs = remaining * perItemMs - Math.min(sinceLast, perItemMs);
  if (!(leftMs > 0)) return undefined;
  const seconds = Math.ceil(leftMs / 1000);
  return seconds > MAX_ETA_SECONDS ? undefined : seconds;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** "3.1 of 5.0 GB", "340 of 900 MB": the units a person's own disk shows. */
export function bytesDetail(done: number, total: number): string {
  if (total >= GIB) return `${(done / GIB).toFixed(1)} of ${(total / GIB).toFixed(1)} GB`;
  return `${String(Math.round(done / MIB))} of ${String(Math.max(1, Math.round(total / MIB)))} MB`;
}

/** "about 12 min", for the wait on YouTube; rounded up, never "0 min". */
function minutesFrom(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "about a minute" : `about ${String(minutes)} min`;
}

/**
 * A step whose job is waiting in line: its place, or that it is next. A job
 * the media machine is holding for disk says that instead — it starts by
 * itself once there is room.
 */
function queuedStep(job: StepJob, starting: string): RunActivity {
  if (job.heldForDisk) {
    return { step: "waiting", label: "Waiting for space to save your video" };
  }
  const ahead = job.ahead ?? 0;
  return ahead > 0
    ? {
        step: "queued",
        label: "Waiting for a free spot",
        detail: `${String(ahead)} ahead of you`,
        queuePosition: ahead,
      }
    : { step: "queued", label: starting, queuePosition: 0 };
}

/** A running job's own progress as a step: its percent and, when earned, its time left. */
function runningStep(job: StepJob, step: ActivityStep, label: string, now: number): RunActivity {
  const eta =
    job.etaMs !== null && job.etaMs > 0
      ? Math.ceil(job.etaMs / 1000)
      : etaFromRate(
          job.samples.map((sample) => ({ at: sample.at, value: sample.progress })),
          100,
          now,
        );
  return {
    step,
    label,
    ...(job.progress > 0 ? { percent: Math.min(100, Math.floor(job.progress)) } : {}),
    ...(eta === undefined ? {} : { etaSeconds: eta }),
  };
}

/** The download: bytes when the worker sends them, its mapped percentage when not. */
function downloadStep(facts: RunActivityFacts): { activity: RunActivity; fraction: number } {
  const job = facts.download;
  if (job === null || job.status === "failed" || job.status === "cancelled") {
    // Nothing is fetching it this moment. YouTube turned this server away
    // (`SourceGate`: the run fetches again by itself), or its turn on the plan
    // has not come, or the next attempt is about to start.
    const busyUntil = facts.sourceBusyUntil;
    if (busyUntil !== null && busyUntil > facts.now) {
      return {
        activity: {
          step: "waiting",
          label: "YouTube asked us to wait",
          detail: `Trying again by itself in ${minutesFrom(busyUntil - facts.now)}`,
        },
        fraction: 0,
      };
    }
    return { activity: { step: "waiting", label: "Waiting to start the download" }, fraction: 0 };
  }
  if (job.status === "queued")
    return { activity: queuedStep(job, "Starting the download"), fraction: 0 };
  if (job.status === "succeeded" || job.progress >= DOWNLOAD_TO) {
    // Checked, kept and stored: minutes on a file of several gigabytes.
    const saving = clamp01((job.progress - DOWNLOAD_TO) / (100 - DOWNLOAD_TO));
    return {
      activity: { step: "downloading", label: "Saving your video" },
      fraction: 0.9 + 0.1 * (job.status === "succeeded" ? 1 : saving),
    };
  }
  if (job.progress < DOWNLOAD_FROM) {
    return {
      activity: { step: "downloading", label: "Checking the video", percent: 0 },
      fraction: 0,
    };
  }

  const withBytes = job.samples.filter(
    (sample) => sample.bytesDone !== undefined && sample.bytesTotal !== undefined,
  );
  const latest = withBytes.at(-1);
  if (latest?.bytesDone !== undefined && latest.bytesTotal !== undefined && latest.bytesTotal > 0) {
    const fraction = clamp01(latest.bytesDone / latest.bytesTotal);
    const eta = etaFromRate(
      withBytes.map((sample) => ({ at: sample.at, value: sample.bytesDone ?? 0 })),
      latest.bytesTotal,
      facts.now,
    );
    return {
      activity: {
        step: "downloading",
        label: "Downloading your video",
        percent: percentOf(fraction),
        detail: bytesDetail(Math.min(latest.bytesDone, latest.bytesTotal), latest.bytesTotal),
        ...(eta === undefined ? {} : { etaSeconds: eta }),
      },
      fraction: 0.9 * fraction,
    };
  }

  // An older worker: no bytes, only the job's percentage, mapped back onto the download.
  const toDownload = (progress: number): number =>
    clamp01((progress - DOWNLOAD_FROM) / (DOWNLOAD_TO - DOWNLOAD_FROM)) * 100;
  const fraction = toDownload(job.progress) / 100;
  const eta = etaFromRate(
    job.samples
      .filter((sample) => sample.progress >= DOWNLOAD_FROM)
      .map((sample) => ({ at: sample.at, value: toDownload(sample.progress) })),
    100,
    facts.now,
  );
  return {
    activity: {
      step: "downloading",
      label: "Downloading your video",
      percent: percentOf(fraction),
      ...(eta === undefined ? {} : { etaSeconds: eta }),
    },
    fraction: 0.9 * fraction,
  };
}

/** A step carried by one job: waiting for it, in line, or running it. */
function jobStep(
  job: StepJob | null,
  now: number,
  words: {
    readonly step: ActivityStep;
    readonly waiting: string;
    readonly starting: string;
    readonly running: string;
    readonly finishing: string;
  },
): { activity: RunActivity; fraction: number } {
  if (job === null || job.status === "failed" || job.status === "cancelled") {
    return { activity: { step: "waiting", label: words.waiting }, fraction: 0 };
  }
  if (job.status === "queued") return { activity: queuedStep(job, words.starting), fraction: 0 };
  if (job.status === "succeeded") {
    return { activity: { step: words.step, label: words.finishing, percent: 100 }, fraction: 1 };
  }
  return {
    activity: runningStep(job, words.step, words.running, now),
    fraction: clamp01(job.progress / 100),
  };
}

/**
 * The clips steps, which overlap: a clip's captioned video is made while the
 * next clip is still being cut. The bar fills each by its own count; the step
 * shown is the first one not finished.
 */
function clipsSteps(
  facts: RunActivityFacts,
  clips: ClipsProgress,
): { activity: RunActivity; fractions: Partial<Record<Phase, number>> } {
  const { now } = facts;
  const settled = clips.ready + clips.failed;
  const fractions: Partial<Record<Phase, number>> = {
    cutting: clips.total === 0 ? 0 : settled / clips.total,
  };
  const auto = facts.automation === "auto";
  if (auto) {
    fractions.captioning = clips.ready === 0 ? 0 : clips.captioned.settled / clips.ready;
    fractions.formats = clips.formats.total === 0 ? 0 : clips.formats.settled / clips.formats.total;
    fractions.images = clips.images.total === 0 ? 0 : clips.images.settled / clips.images.total;
  }

  if (clips.cutting + clips.waiting > 0) {
    if (clips.cutting === 0) {
      const preparing = facts.media !== null && facts.media.status !== "ready";
      return {
        activity: {
          step: "waiting",
          label: preparing
            ? "Waiting for your video to finish preparing"
            : "Your clips are waiting their turn",
          detail: `${String(clips.ready)} of ${String(clips.total)} ready`,
        },
        fractions,
      };
    }
    const eta = etaFromThroughput(clips.finished.cuts, clips.cutting + clips.waiting, now);
    return {
      activity: {
        step: "cutting",
        label: "Cutting your clips",
        percent: percentOf(settled / clips.total),
        detail: `clip ${String(Math.min(settled + 1, clips.total))} of ${String(clips.total)}`,
        ...(eta === undefined ? {} : { etaSeconds: eta }),
      },
      fractions,
    };
  }

  if (auto && clips.ready > 0) {
    if (clips.captioned.settled < clips.ready) {
      const left = clips.ready - clips.captioned.settled;
      const eta = etaFromThroughput(clips.finished.captioned, left, now);
      return {
        activity: {
          step: "captioning",
          label: "Adding captions to your clips",
          percent: percentOf(clips.captioned.settled / clips.ready),
          detail: `video ${String(clips.captioned.settled + 1)} of ${String(clips.ready)}`,
          ...(eta === undefined ? {} : { etaSeconds: eta }),
        },
        fractions,
      };
    }
    if (clips.formats.settled < clips.formats.total) {
      if (clips.lowDisk) {
        return {
          activity: {
            step: "waiting",
            label: "Waiting for storage space to make the other sizes",
            detail: `${String(clips.formats.settled)} of ${String(clips.formats.total)} made`,
          },
          fractions,
        };
      }
      const left = clips.formats.total - clips.formats.settled;
      const eta = etaFromThroughput(clips.finished.formats, left, now);
      return {
        activity: {
          step: "formats",
          label: "Making the other sizes",
          percent: percentOf(clips.formats.settled / clips.formats.total),
          detail: `video ${String(clips.formats.settled + 1)} of ${String(clips.formats.total)}`,
          ...(eta === undefined ? {} : { etaSeconds: eta }),
        },
        fractions,
      };
    }
    if (clips.images.settled < clips.images.total) {
      if (clips.lowDisk) {
        return {
          activity: {
            step: "waiting",
            label: "Waiting for storage space to make the images",
            detail: `${String(clips.images.settled)} of ${String(clips.images.total)} clips done`,
          },
          fractions,
        };
      }
      const left = clips.images.total - clips.images.settled;
      const eta = etaFromThroughput(clips.finished.images, left, now);
      return {
        activity: {
          step: "images",
          label: "Making the images",
          percent: percentOf(clips.images.settled / clips.images.total),
          detail: `clip ${String(clips.images.settled + 1)} of ${String(clips.images.total)}`,
          ...(eta === undefined ? {} : { etaSeconds: eta }),
        },
        fractions,
      };
    }
  }

  return {
    activity: { step: "done", label: auto ? "All done" : "Your clips are ready" },
    fractions,
  };
}

/**
 * The activity and the bar for a run, from its facts. Null activity for a run
 * that has stopped (the error card or "You stopped this run" says what
 * happened), and for the statuses past review, whose bar keeps its numbers.
 */
export function activityOf(facts: RunActivityFacts): ActivityResult {
  const phases = phasesOf(facts);
  const bar = (fractions: Partial<Record<Phase, number>>): number =>
    overallProgress(phases, fractions, facts.automation);

  switch (facts.status) {
    case "failed":
    case "cancelled":
    case "publishing":
    case "partially_published":
    case "published":
      return NONE;

    case "draft":
    case "acquiring": {
      if (facts.sourceKind === "upload") {
        // The browser is sending the file; the server sees it when it lands.
        return {
          activity: { step: "waiting", label: "Waiting for your video to upload" },
          progress: 0,
        };
      }
      const { activity, fraction } = downloadStep(facts);
      return { activity, progress: bar(upTo(phases, "downloading", fraction)) };
    }

    case "preparing_media": {
      const { activity, fraction } = jobStep(facts.preparation, facts.now, {
        step: "preparing",
        waiting: "Getting your video ready",
        starting: "Starting to prepare your video",
        running: "Preparing audio and preview",
        finishing: "Preparing audio and preview",
      });
      return { activity, progress: bar(upTo(phases, "preparing", fraction)) };
    }

    case "transcribing": {
      const { activity, fraction } = jobStep(facts.transcription, facts.now, {
        step: "transcribing",
        waiting: "Waiting to start the transcript",
        starting: "Starting the transcript",
        running: "Writing the transcript",
        finishing: "Finishing the transcript",
      });
      return { activity, progress: bar(upTo(phases, "transcribing", fraction)) };
    }

    case "analyzing": {
      const { activity, fraction } = jobStep(facts.discovery, facts.now, {
        step: "finding",
        waiting: "Getting ready to find moments",
        starting: "Starting to look for moments",
        running: "Finding the best moments",
        finishing: "Finding the best moments",
      });
      return { activity, progress: bar(upTo(phases, "finding", fraction)) };
    }

    case "candidates_ready":
    case "materializing":
    case "rendering":
    case "review_ready":
    case "changes_requested":
    case "approved": {
      const clips = facts.clips;
      const ahead = upTo(phases, "cutting", 0);
      if (clips === null || clips.total === 0) {
        if (facts.status === "candidates_ready") {
          const auto = facts.automation === "auto" && facts.candidateCount > 0;
          return {
            activity: auto
              ? { step: "cutting", label: "Starting your clips", percent: 0 }
              : {
                  step: "waiting",
                  label:
                    facts.candidateCount > 0
                      ? "Pick the moments you want as clips"
                      : "Add the moments you want as clips",
                },
            progress: bar(ahead),
          };
        }
        return { activity: null, progress: null };
      }
      const { activity, fractions } = clipsSteps(facts, clips);
      const progress = bar({ ...ahead, ...fractions });
      if (activity.step === "done" && (facts.status === "candidates_ready" || clips.ready === 0)) {
        // Nothing is being made and no clip came out (every cut failed): the
        // next step is the person's, on the moments.
        return {
          activity: { step: "waiting", label: "Pick the moments you want as clips" },
          progress: bar(ahead),
        };
      }
      // Past review a manual run keeps the coarse numbers it always had.
      if (facts.automation !== "auto" && facts.status === "approved") {
        return { activity, progress: progressForStatus("approved") };
      }
      return { activity, progress };
    }
  }
}

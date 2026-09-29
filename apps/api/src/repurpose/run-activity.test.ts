import { describe, expect, it } from "vitest";

import { beginnerSafetyViolations, progressForStatus } from "./repurpose.projection.js";
import {
  MIN_RATE_SPAN_MS,
  STALE_SAMPLE_MS,
  STEP_WEIGHTS,
  activityOf,
  bytesDetail,
  etaFromRate,
  etaFromThroughput,
  overallProgress,
  phasesOf,
} from "./run-activity.js";

import type {
  ClipsProgress,
  ProgressSample,
  RunActivity,
  RunActivityFacts,
  StepJob,
} from "./run-activity.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const GIB = 1024 ** 3;

function facts(overrides: Partial<RunActivityFacts> = {}): RunActivityFacts {
  return {
    now: NOW,
    status: "acquiring",
    automation: "auto",
    sourceKind: "youtube_url",
    candidateCount: 0,
    sourceBusyUntil: null,
    media: { status: "pending", arrived: false },
    download: null,
    preparation: null,
    transcription: null,
    discovery: null,
    clips: null,
    ...overrides,
  };
}

function job(overrides: Partial<StepJob> = {}): StepJob {
  return {
    status: "running",
    progress: 0,
    etaMs: null,
    samples: [],
    ahead: null,
    heldForDisk: false,
    ...overrides,
  };
}

/** A download reporting every minute, `gib` downloaded at each report, of a `total` GiB video. */
function downloadSamples(
  gib: readonly number[],
  total: number,
  endAt = NOW - 10_000,
): ProgressSample[] {
  return gib.map((done, index) => ({
    at: endAt - (gib.length - 1 - index) * 60_000,
    progress: 5 + (done / total) * 65,
    bytesDone: Math.round(done * GIB),
    bytesTotal: Math.round(total * GIB),
  }));
}

function clips(overrides: Partial<ClipsProgress> = {}): ClipsProgress {
  const none = { at: [], durationsMs: [] };
  return {
    total: 0,
    ready: 0,
    cutting: 0,
    waiting: 0,
    failed: 0,
    usable: 0,
    captioned: { ready: 0, settled: 0 },
    formats: { total: 0, settled: 0 },
    images: { total: 0, settled: 0 },
    finished: { cuts: none, captioned: none, formats: none, images: none },
    lowDisk: false,
    ...overrides,
  };
}

describe("the owner's report: a 5 GB download at 67% said 5% complete", () => {
  const samples = downloadSamples([1.0, 1.7, 2.4, 3.36], 5);
  const result = activityOf(facts({ download: job({ progress: 5 + 0.67 * 65, samples }) }));

  it("says what the download is doing, in the video's own units", () => {
    expect(result.activity).toMatchObject({
      step: "downloading",
      label: "Downloading your video",
      percent: 67,
      detail: "3.4 of 5.0 GB",
    });
  });

  it("says how long is left, from the rate it has really been moving at", () => {
    // 2.36 GB in three minutes; 1.64 GB to go is about 125 s from the last
    // report, which was ten seconds ago.
    expect(result.activity?.etaSeconds).toBeGreaterThanOrEqual(110);
    expect(result.activity?.etaSeconds).toBeLessThanOrEqual(125);
  });

  it("moves the run's bar with the download instead of holding it at the status's 5%", () => {
    expect(result.progress).toBeGreaterThan(progressForStatus("acquiring"));
    const early = activityOf(
      facts({ download: job({ progress: 5 + 0.1 * 65, samples: downloadSamples([0.5], 5) }) }),
    );
    expect(result.progress ?? 0).toBeGreaterThan(early.progress ?? 0);
  });
});

describe("the download step", () => {
  it("falls back to the job's own percentage from a worker that sends no bytes", () => {
    const samples = [0, 1, 2].map((index) => ({
      at: NOW - (2 - index) * 60_000,
      progress: 5 + (0.2 + 0.2 * index) * 65,
    }));
    const { activity } = activityOf(facts({ download: job({ progress: 5 + 0.6 * 65, samples }) }));
    expect(activity).toMatchObject({ step: "downloading", percent: 60 });
    expect(activity?.detail).toBeUndefined();
    // 40 points in two minutes, 40 to go: about two minutes.
    expect(activity?.etaSeconds).toBeGreaterThanOrEqual(115);
    expect(activity?.etaSeconds).toBeLessThanOrEqual(120);
  });

  it("gives no time left when the download has gone quiet", () => {
    const stale = downloadSamples([1, 2], 5, NOW - STALE_SAMPLE_MS - 1_000);
    const { activity } = activityOf(facts({ download: job({ progress: 31, samples: stale }) }));
    expect(activity?.step).toBe("downloading");
    expect(activity?.etaSeconds).toBeUndefined();
  });

  it("gives no time left before the download has moved long enough to time", () => {
    const quick = [
      { at: NOW - MIN_RATE_SPAN_MS + 5_000, progress: 20, bytesDone: GIB, bytesTotal: 5 * GIB },
      { at: NOW, progress: 25, bytesDone: 2 * GIB, bytesTotal: 5 * GIB },
    ];
    const { activity } = activityOf(facts({ download: job({ progress: 25, samples: quick }) }));
    expect(activity?.percent).toBe(40);
    expect(activity?.etaSeconds).toBeUndefined();
  });

  it("says where it is in line while other people's videos are ahead of it", () => {
    const { activity } = activityOf(facts({ download: job({ status: "queued", ahead: 2 }) }));
    expect(activity).toEqual({
      step: "queued",
      label: "Waiting for a free spot",
      detail: "2 ahead of you",
      queuePosition: 2,
    });
    const next = activityOf(facts({ download: job({ status: "queued", ahead: 0 }) }));
    expect(next.activity).toEqual({
      step: "queued",
      label: "Starting the download",
      queuePosition: 0,
    });
  });

  it("waits for disk rather than pretending to be in line", () => {
    const { activity } = activityOf(
      facts({ download: job({ status: "queued", ahead: 0, heldForDisk: true }) }),
    );
    expect(activity).toEqual({ step: "waiting", label: "Waiting for space to save your video" });
  });

  it("says YouTube asked us to wait, and when it tries again, while nothing is fetching", () => {
    const { activity } = activityOf(facts({ sourceBusyUntil: NOW + 12 * 60_000 - 5_000 }));
    expect(activity).toEqual({
      step: "waiting",
      label: "YouTube asked us to wait",
      detail: "Trying again by itself in about 12 min",
    });
  });

  it("shows a download that is running even while YouTube refuses new ones", () => {
    const { activity } = activityOf(
      facts({
        sourceBusyUntil: NOW + 60_000,
        download: job({ progress: 40, samples: downloadSamples([2], 5) }),
      }),
    );
    expect(activity?.step).toBe("downloading");
  });

  it("says it is checking the video first, and saving it after", () => {
    expect(activityOf(facts({ download: job({ progress: 2 }) })).activity).toMatchObject({
      label: "Checking the video",
    });
    expect(activityOf(facts({ download: job({ progress: 85 }) })).activity).toEqual({
      step: "downloading",
      label: "Saving your video",
    });
  });

  it("waits for an upload the browser is still sending", () => {
    const result = activityOf(facts({ sourceKind: "upload", status: "draft", media: null }));
    expect(result).toEqual({
      activity: { step: "waiting", label: "Waiting for your video to upload" },
      progress: 0,
    });
  });
});

describe("the steps after the download", () => {
  it("prepares, transcribes and finds moments with each job's own progress", () => {
    const preparing = activityOf(
      facts({ status: "preparing_media", preparation: job({ progress: 55 }) }),
    );
    expect(preparing.activity).toMatchObject({
      step: "preparing",
      label: "Preparing audio and preview",
      percent: 55,
    });

    const samples = [
      { at: NOW - 240_000, progress: 10 },
      { at: NOW - 120_000, progress: 30 },
      { at: NOW - 1_000, progress: 50 },
    ];
    const transcribing = activityOf(
      facts({ status: "transcribing", transcription: job({ progress: 50, samples }) }),
    );
    expect(transcribing.activity).toMatchObject({ step: "transcribing", percent: 50 });
    // 40 points in about four minutes, 50 to go: about five minutes.
    expect(transcribing.activity?.etaSeconds).toBeGreaterThan(280);
    expect(transcribing.activity?.etaSeconds).toBeLessThan(310);

    const finding = activityOf(facts({ status: "analyzing", discovery: job({ progress: 0 }) }));
    expect(finding.activity).toEqual({ step: "finding", label: "Finding the best moments" });
  });

  it("prefers the worker's own estimate when it sends one", () => {
    const { activity } = activityOf(
      facts({ status: "transcribing", transcription: job({ progress: 40, etaMs: 90_500 }) }),
    );
    expect(activity?.etaSeconds).toBe(91);
  });

  it("waits, honestly, for a step that has no job yet", () => {
    expect(activityOf(facts({ status: "transcribing" })).activity).toEqual({
      step: "waiting",
      label: "Waiting to start the transcript",
    });
  });
});

describe("the clips steps", () => {
  it("counts the clips as they are cut, with the time the last ones took", () => {
    const finished = {
      cuts: { at: [NOW - 180_000, NOW - 120_000, NOW - 60_000], durationsMs: [] },
      captioned: { at: [], durationsMs: [] },
      formats: { at: [], durationsMs: [] },
      images: { at: [], durationsMs: [] },
    };
    const { activity } = activityOf(
      facts({
        status: "materializing",
        media: { status: "ready", arrived: true },
        clips: clips({ total: 10, ready: 2, failed: 0, cutting: 1, waiting: 7, finished }),
      }),
    );
    expect(activity).toMatchObject({
      step: "cutting",
      label: "Cutting your clips",
      percent: 20,
      detail: "clip 3 of 10",
    });
    // One a minute, eight to go, the current one a minute in: about 7 minutes.
    expect(activity?.etaSeconds).toBe(7 * 60);
  });

  it("says the clips wait their turn when none is being cut", () => {
    const { activity } = activityOf(
      facts({
        status: "materializing",
        media: { status: "ready", arrived: true },
        clips: clips({ total: 4, ready: 1, waiting: 3 }),
      }),
    );
    expect(activity).toEqual({
      step: "waiting",
      label: "Your clips are waiting their turn",
      detail: "1 of 4 ready",
    });
  });

  it("walks an Autopilot run through captions, the other sizes and the images", () => {
    const base = {
      status: "review_ready" as const,
      media: { status: "ready" as const, arrived: true },
    };
    const captioning = activityOf(
      facts({
        ...base,
        clips: clips({ total: 40, ready: 40, captioned: { ready: 11, settled: 11 } }),
      }),
    );
    expect(captioning.activity).toMatchObject({
      step: "captioning",
      detail: "video 12 of 40",
      percent: 27,
    });

    const formats = activityOf(
      facts({
        ...base,
        clips: clips({
          total: 10,
          ready: 10,
          captioned: { ready: 10, settled: 10 },
          formats: { total: 30, settled: 11 },
        }),
      }),
    );
    expect(formats.activity).toMatchObject({ step: "formats", detail: "video 12 of 30" });

    const lowDisk = activityOf(
      facts({
        ...base,
        clips: clips({
          total: 10,
          ready: 10,
          captioned: { ready: 10, settled: 10 },
          formats: { total: 30, settled: 11 },
          lowDisk: true,
        }),
      }),
    );
    expect(lowDisk.activity).toMatchObject({
      step: "waiting",
      label: "Waiting for storage space to make the other sizes",
    });

    const images = activityOf(
      facts({
        ...base,
        clips: clips({
          total: 10,
          ready: 10,
          captioned: { ready: 10, settled: 10 },
          formats: { total: 30, settled: 30 },
          images: { total: 10, settled: 2 },
        }),
      }),
    );
    expect(images.activity).toMatchObject({ step: "images", detail: "clip 3 of 10" });

    const done = activityOf(
      facts({
        ...base,
        clips: clips({
          total: 10,
          ready: 9,
          failed: 1,
          captioned: { ready: 9, settled: 9 },
          formats: { total: 27, settled: 27 },
          images: { total: 9, settled: 9 },
        }),
      }),
    );
    expect(done).toEqual({ activity: { step: "done", label: "All done" }, progress: 100 });
  });

  it("ends a run whose person picks the moments at review, as its bar always did", () => {
    const result = activityOf(
      facts({
        status: "review_ready",
        automation: "manual",
        media: { status: "ready", arrived: true },
        clips: clips({ total: 2, ready: 2, usable: 2 }),
      }),
    );
    expect(result).toEqual({
      activity: { step: "done", label: "Your clips are ready" },
      progress: progressForStatus("review_ready"),
    });
  });

  it("hands the next step to the person when the moments are theirs to pick", () => {
    const manual = activityOf(
      facts({ status: "candidates_ready", automation: "manual", candidateCount: 6 }),
    );
    expect(manual.activity).toEqual({
      step: "waiting",
      label: "Pick the moments you want as clips",
    });
    const none = activityOf(facts({ status: "candidates_ready", candidateCount: 0 }));
    expect(none.activity).toEqual({ step: "waiting", label: "Add the moments you want as clips" });
    const autopilot = activityOf(facts({ status: "candidates_ready", candidateCount: 6 }));
    expect(autopilot.activity).toMatchObject({ step: "cutting", label: "Starting your clips" });
    // Every cut failed and nothing is running: back to the moments.
    const allFailed = activityOf(
      facts({
        status: "candidates_ready",
        candidateCount: 3,
        clips: clips({ total: 3, failed: 3 }),
      }),
    );
    expect(allFailed.activity?.step).toBe("waiting");
  });

  it("says nothing for a run that stopped: its own card says what happened", () => {
    for (const status of ["failed", "cancelled", "published"] as const) {
      expect(activityOf(facts({ status }))).toEqual({ activity: null, progress: null });
    }
  });
});

describe("the run's bar", () => {
  it("weighs every step a run takes, and only those", () => {
    expect(phasesOf({ sourceKind: "youtube_url", automation: "auto" })).toEqual([
      "downloading",
      "preparing",
      "transcribing",
      "finding",
      "cutting",
      "captioning",
      "formats",
      "images",
    ]);
    expect(phasesOf({ sourceKind: "upload", automation: "manual" })).toEqual([
      "preparing",
      "transcribing",
      "finding",
      "cutting",
    ]);
    const total = Object.values(STEP_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });

  it("never steps back as one step hands over to the next", () => {
    const run = { sourceKind: "youtube_url" as const, automation: "auto" as const };
    const phases = phasesOf(run);
    let previous = 0;
    for (const [index, phase] of phases.entries()) {
      const fractions = Object.fromEntries(phases.slice(0, index).map((each) => [each, 1]));
      const start = overallProgress(phases, { ...fractions, [phase]: 0 }, "auto");
      const end = overallProgress(phases, { ...fractions, [phase]: 1 }, "auto");
      expect(start, phase).toBeGreaterThanOrEqual(previous);
      expect(end, phase).toBeGreaterThanOrEqual(start);
      previous = end;
    }
    expect(previous).toBe(100);
  });

  it("gives a download of the Autopilot run its 15 points", () => {
    const phases = phasesOf({ sourceKind: "youtube_url", automation: "auto" });
    expect(overallProgress(phases, { downloading: 1 }, "auto")).toBe(15);
  });
});

describe("estimates", () => {
  it("times a rate only over a recent, long enough stretch", () => {
    const points = [
      { at: NOW - 120_000, value: 10 },
      { at: NOW - 60_000, value: 40 },
    ];
    expect(etaFromRate(points, 100, NOW - 60_000)).toBe(120);
    expect(etaFromRate(points.slice(1), 100, NOW)).toBeUndefined();
    expect(etaFromRate(points, 40, NOW)).toBeUndefined();
    expect(etaFromRate(points, 100, NOW + STALE_SAMPLE_MS)).toBeUndefined();
  });

  it("times a line of work by the gaps between recent finishes, or one item's own length", () => {
    expect(
      etaFromThroughput(
        { at: [NOW - 90_000, NOW - 60_000, NOW - 30_000], durationsMs: [] },
        4,
        NOW,
      ),
    ).toBe(90);
    expect(etaFromThroughput({ at: [NOW - 10_000], durationsMs: [50_000] }, 2, NOW)).toBe(90);
    expect(etaFromThroughput({ at: [], durationsMs: [] }, 3, NOW)).toBeUndefined();
    // A line silent for far longer than its items take has stopped.
    expect(
      etaFromThroughput({ at: [NOW - 3_600_000, NOW - 3_540_000], durationsMs: [] }, 3, NOW),
    ).toBeUndefined();
  });

  it("writes sizes the way a person's own disk shows them", () => {
    expect(bytesDetail(3.1 * GIB, 5 * GIB)).toBe("3.1 of 5.0 GB");
    expect(bytesDetail(340 * 1024 ** 2, 900 * 1024 ** 2)).toBe("340 of 900 MB");
  });
});

describe("what a person reads", () => {
  it("never names the machinery", () => {
    const everything: RunActivity[] = [];
    const add = (result: { activity: RunActivity | null }): void => {
      if (result.activity !== null) everything.push(result.activity);
    };
    add(activityOf(facts({ download: job({ status: "queued", ahead: 3 }) })));
    add(activityOf(facts({ download: job({ status: "queued", heldForDisk: true }) })));
    add(activityOf(facts({ sourceBusyUntil: NOW + 60_000 })));
    add(activityOf(facts({ download: job({ progress: 40, samples: downloadSamples([2], 5) }) })));
    add(activityOf(facts({ status: "preparing_media" })));
    add(activityOf(facts({ status: "analyzing", discovery: job({ status: "queued", ahead: 0 }) })));
    add(
      activityOf(
        facts({
          status: "review_ready",
          clips: clips({
            total: 3,
            ready: 3,
            captioned: { ready: 3, settled: 3 },
            formats: { total: 9, settled: 1 },
            lowDisk: true,
          }),
        }),
      ),
    );
    expect(everything.length).toBeGreaterThan(5);
    for (const activity of everything) {
      expect(beginnerSafetyViolations(`${activity.label} ${activity.detail ?? ""}`)).toEqual([]);
    }
  });
});

import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyTables, memoryPrisma } from "./automations-memory.test-support.js";
import { parseChannelFeed } from "./channel-feed.js";
import {
  SOURCE_WATCH_TASK,
  SOURCE_WATCH_TICK_MS,
  WATCHES_PER_TICK,
  WATCH_CHECK_EVERY_MS,
  WATCH_FETCH_SPACING_MS,
} from "./source-watch.constants.js";
import { watchSetupSchema } from "./source-watch.dto.js";
import { SourceWatchPoller } from "./source-watch.poller.js";
import { ChannelLookupError } from "./youtube-channels.js";
import { CHANNEL, feedXml } from "./youtube-fixtures.test-support.js";
import { AppException } from "../../common/errors/error-codes.js";
import { REPURPOSE_ERRORS } from "../repurpose.constants.js";

import type { Row, Tables } from "./automations-memory.test-support.js";
import type { ChannelFeed } from "./channel-feed.js";
import type { ChannelDirectory } from "./youtube-channels.js";
import type { FixtureEntry } from "./youtube-fixtures.test-support.js";

const WS = "01JWS00000000000000000000A";
const USER = "01JUSER0000000000000000000";
const WATCH = "01JWATCH000000000000000000";
const CREATED = new Date("2026-10-01T00:00:00Z");

const SETUP = watchSetupSchema.parse({
  sourceLanguage: "auto",
  caption: { styleId: "punch-pop" },
  discovery: { mode: "ai", topic: "money habits" },
  automation: "auto",
});

function watchRow(overrides: Row = {}): Row {
  return {
    id: WATCH,
    workspaceId: WS,
    kind: "youtube_channel",
    channelId: CHANNEL,
    title: "Aksharo Test Kitchen",
    handle: "AksharoTestKitchen",
    setup: SETUP,
    backfillCount: 0,
    state: "active",
    stateReason: null,
    stateChangedAt: CREATED,
    lastCheckedAt: null,
    nextCheckAt: CREATED,
    checkFailures: 0,
    lastErrorCode: null,
    cursor: null,
    rightsAttestedAt: CREATED,
    rightsAttestedBy: USER,
    createdBy: USER,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function upload(n: number, published: string, extra: Partial<FixtureEntry> = {}): FixtureEntry {
  return {
    videoId: `vid${String(n).padStart(8, "0")}`,
    title: `Episode ${String(n)}`,
    published,
    views: 500,
    ...extra,
  };
}

interface Harness {
  readonly tables: Tables;
  readonly poller: SourceWatchPoller;
  readonly runs: { create: ReturnType<typeof vi.fn>; flagEnabled: ReturnType<typeof vi.fn> };
  readonly watches: { enabled: ReturnType<typeof vi.fn>; canStartAs: ReturnType<typeof vi.fn> };
  readonly notices: { newVideo: ReturnType<typeof vi.fn>; paused: ReturnType<typeof vi.fn> };
  readonly audit: { record: ReturnType<typeof vi.fn> };
  readonly scheduler: { register: ReturnType<typeof vi.fn> };
  readonly uploads: ReturnType<typeof vi.fn>;
  readonly sleep: ReturnType<typeof vi.fn>;
  /** Move the poller's clock. */
  at(iso: string | Date): void;
  feed(entries: readonly FixtureEntry[]): void;
}

function harness(watches: Row[] = [watchRow()]): Harness {
  const tables = emptyTables();
  tables.sourceWatch.push(...watches);
  const prisma = memoryPrisma(tables);
  let now = new Date("2026-10-02T10:00:00Z");
  let feed: ChannelFeed = parseChannelFeed(feedXml([]));
  let runNo = 0;

  const runs = {
    flagEnabled: vi.fn(async () => true),
    // A real create makes a run row, which is what a crash recovery looks for.
    create: vi.fn(async (_ws: string, _user: string, input: { source: { url: string } }) => {
      runNo += 1;
      const id = `01JRUN${String(runNo).padStart(20, "0")}`;
      const videoId = new URL(input.source.url).searchParams.get("v");
      tables.repurposeRun.push({
        id,
        workspaceId: WS,
        sourceFingerprint: `youtube:${videoId ?? ""}`,
        status: "acquiring",
        createdAt: now,
      });
      return { run: { id } };
    }),
  };
  const watchService = {
    enabled: vi.fn(async () => true),
    canStartAs: vi.fn(async () => true),
  };
  const notices = { newVideo: vi.fn(async () => undefined), paused: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const scheduler = { register: vi.fn() };
  const uploads = vi.fn(async (): Promise<ChannelFeed> => feed);
  const directory: ChannelDirectory = { resolve: vi.fn(), uploads };

  const poller = new SourceWatchPoller(
    prisma as never,
    runs as never,
    watchService as never,
    notices as never,
    audit as never,
    scheduler as never,
    directory,
  );
  const sleep = vi.fn(async () => undefined);
  poller.clock = () => now;
  poller.sleep = sleep;
  poller.random = () => 0;

  return {
    tables,
    poller,
    runs,
    watches: watchService,
    notices,
    audit,
    scheduler,
    uploads,
    sleep,
    at: (value) => {
      now = new Date(value);
    },
    feed: (entries) => {
      feed = parseChannelFeed(feedXml(entries));
    },
  };
}

function videoRows(tables: Tables): Row[] {
  return [...tables.sourceWatchVideo].sort((a, b) =>
    String(a["videoId"]).localeCompare(String(b["videoId"])),
  );
}

function stateOf(tables: Tables, videoId: string): unknown {
  return tables.sourceWatchVideo.find((row) => row["videoId"] === videoId)?.["state"];
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

describe("SourceWatchPoller: the task", () => {
  it("registers repurpose.source-watch every fifteen minutes, and does nothing else until run", () => {
    h.poller.onModuleInit();
    expect(h.scheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: SOURCE_WATCH_TASK, everyMs: SOURCE_WATCH_TICK_MS }),
    );
    expect(SOURCE_WATCH_TASK).toBe("repurpose.source-watch");
    expect(h.uploads).not.toHaveBeenCalled();
  });
});

describe("SourceWatchPoller: new uploads", () => {
  beforeEach(() => {
    h.feed([
      upload(1, "2026-09-20T00:00:00Z"), // before the watch: the back catalogue
      upload(2, "2026-10-01T06:00:00Z"),
      upload(3, "2026-10-01T09:00:00Z", { link: "https://www.youtube.com/shorts/vid00000003" }),
      upload(4, "2026-10-01T12:00:00Z"),
      upload(5, "2026-10-02T08:00:00Z"),
      upload(6, "2026-10-02T09:30:00Z", { views: 0 }), // a premiere, not yet watchable
    ]);
  });

  it("starts up to two new uploads per check, oldest first, as Autopilot runs through the start form's path", async () => {
    const report = await h.poller.tick();
    expect(report).toMatchObject({ due: 1, read: 1, recorded: 4, started: 2, busy: false });

    expect(h.runs.create).toHaveBeenCalledTimes(2);
    const [ws, user, input, origin] = h.runs.create.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(ws).toBe(WS);
    expect(user).toBe(USER);
    expect(input).toMatchObject({
      source: {
        kind: "url",
        url: "https://www.youtube.com/watch?v=vid00000002",
        rightsAttested: true,
      },
      setup: { automation: "auto", discovery: { mode: "ai", topic: "money habits" } },
      title: "Episode 2",
    });
    // The attestation it was connected under, not a fresh one.
    expect(origin).toEqual({
      attestation: { at: CREATED, by: USER, of: `watch:${WATCH}` },
    });
    expect(
      (h.runs.create.mock.calls[1] as [string, string, { source: { url: string } }])[2].source.url,
    ).toBe("https://www.youtube.com/watch?v=vid00000004");

    expect(videoRows(h.tables).map((row) => [row["videoId"], row["state"], row["reason"]])).toEqual(
      [
        ["vid00000002", "started", null],
        ["vid00000003", "skipped", "short"],
        ["vid00000004", "started", null],
        ["vid00000005", "pending", null],
      ],
    );
    expect(h.tables.sourceWatchVideo.every((row) => row["runId"] !== undefined)).toBe(true);
    expect(h.notices.newVideo).toHaveBeenCalledTimes(2);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.watch.run_started", actorKind: "system" }),
    );

    const watch = h.tables.sourceWatch[0] as Row;
    expect(watch["lastCheckedAt"]).toEqual(new Date("2026-10-02T10:00:00Z"));
    expect((watch["nextCheckAt"] as Date).getTime()).toBe(
      new Date("2026-10-02T10:00:00Z").getTime() + WATCH_CHECK_EVERY_MS,
    );
    // The premiere is not in the cursor, so the next read looks at it again.
    expect((watch["cursor"] as { seen: string[] }).seen).not.toContain("vid00000006");
    expect((watch["cursor"] as { seen: string[] }).seen).toContain("vid00000001");
  });

  it("is not read again before its hour is up, and the next check starts what is left", async () => {
    await h.poller.tick();
    h.at("2026-10-02T10:30:00Z");
    expect(await h.poller.tick()).toMatchObject({ due: 0, read: 0 });
    expect(h.uploads).toHaveBeenCalledTimes(1);

    h.at("2026-10-02T11:05:00Z");
    expect(await h.poller.tick()).toMatchObject({ read: 1, recorded: 0, started: 1 });
    expect(stateOf(h.tables, "vid00000005")).toBe("started");
    // Three runs in all, one per upload: nothing was started twice.
    expect(h.runs.create).toHaveBeenCalledTimes(3);
    expect(new Set(h.tables.sourceWatchVideo.map((row) => row["runId"])).size).toBe(4);
  });

  it("picks up the premiere once it has views", async () => {
    await h.poller.tick();
    expect(stateOf(h.tables, "vid00000006")).toBeUndefined();
    h.feed([upload(6, "2026-10-02T09:30:00Z", { views: 1200 })]);
    h.at("2026-10-02T11:30:00Z");
    expect(await h.poller.tick()).toMatchObject({ recorded: 1, started: 2 });
    // Recorded at this read, and started with the one left over from the last.
    expect(stateOf(h.tables, "vid00000005")).toBe("started");
    expect(stateOf(h.tables, "vid00000006")).toBe("started");
    expect(h.runs.create).toHaveBeenCalledTimes(4);
  });
});

describe("SourceWatchPoller: one run per upload, whatever crashes", () => {
  beforeEach(() => {
    h.feed([upload(2, "2026-10-01T06:00:00Z")]);
  });

  it("files a run whose filing was lost against that run, never starting a second", async () => {
    const prisma = (h.poller as unknown as { prisma: ReturnType<typeof memoryPrisma> }).prisma;
    const update = prisma.sourceWatchVideo.update.bind(prisma.sourceWatchVideo);
    // The run is made, then the write that files it on the row is lost.
    prisma.sourceWatchVideo.update = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await h.poller.tick();
    expect(h.runs.create).toHaveBeenCalledTimes(1);
    expect(stateOf(h.tables, "vid00000002")).toBe("starting");
    prisma.sourceWatchVideo.update = update;

    // An hour on, the claim is stale: it is filed against the run that exists.
    h.at("2026-10-02T11:30:00Z");
    await h.poller.tick();
    expect(stateOf(h.tables, "vid00000002")).toBe("started");
    expect(h.tables.sourceWatchVideo[0]?.["runId"]).toBe(h.tables.repurposeRun[0]?.["id"]);
    expect(h.runs.create).toHaveBeenCalledTimes(1);
  });

  it("puts a claim whose run never came back to pending, and starts it once", async () => {
    // A poll died after claiming the video and before creating the run.
    h.tables.sourceWatchVideo.push({
      id: "01JVIDEO000000000000000001",
      watchId: WATCH,
      videoId: "vid00000002",
      title: "Episode 2",
      publishedAt: new Date("2026-10-01T06:00:00Z"),
      state: "starting",
      reason: null,
      backfill: false,
      runId: null,
      attempts: 0,
      claimedAt: new Date("2026-10-02T09:30:00Z"),
      createdAt: new Date("2026-10-02T09:30:00Z"),
      updatedAt: new Date("2026-10-02T09:30:00Z"),
    });
    await h.poller.tick();
    expect(h.runs.create).toHaveBeenCalledTimes(1);
    expect(stateOf(h.tables, "vid00000002")).toBe("started");
  });

  it("leaves a fresh claim alone: another poll may be creating that run right now", async () => {
    h.tables.sourceWatchVideo.push({
      id: "01JVIDEO000000000000000001",
      watchId: WATCH,
      videoId: "vid00000002",
      title: "Episode 2",
      publishedAt: new Date("2026-10-01T06:00:00Z"),
      state: "starting",
      claimedAt: new Date("2026-10-02T09:58:00Z"),
      attempts: 0,
      backfill: false,
      runId: null,
      reason: null,
    });
    await h.poller.tick();
    expect(h.runs.create).not.toHaveBeenCalled();
    expect(stateOf(h.tables, "vid00000002")).toBe("starting");
  });

  it("files a video already running by hand against that run", async () => {
    h.runs.create.mockRejectedValueOnce(
      new AppException(REPURPOSE_ERRORS.sourceDuplicate, "already", HttpStatus.CONFLICT, {
        existingRunId: "01JRUNBYHAND00000000000000",
      }),
    );
    await h.poller.tick();
    expect(h.tables.sourceWatchVideo[0]).toMatchObject({
      state: "started",
      runId: "01JRUNBYHAND00000000000000",
      reason: "already_running",
    });
    expect(h.notices.newVideo).not.toHaveBeenCalled();
  });

  it("never records a video twice when two polls read the same feed", async () => {
    const second = new SourceWatchPoller(
      (h.poller as unknown as { prisma: unknown }).prisma as never,
      h.runs as never,
      h.watches as never,
      h.notices as never,
      h.audit as never,
      h.scheduler as never,
      { resolve: vi.fn(), uploads: h.uploads },
    );
    second.clock = h.poller.clock;
    second.sleep = h.sleep as never;
    second.random = () => 0;
    await Promise.all([h.poller.tick(), second.tick()]);
    expect(h.tables.sourceWatchVideo).toHaveLength(1);
    expect(h.runs.create).toHaveBeenCalledTimes(1);
  });
});

describe("SourceWatchPoller: when a start is refused", () => {
  beforeEach(() => {
    h.feed([upload(2, "2026-10-01T06:00:00Z"), upload(4, "2026-10-01T12:00:00Z")]);
  });

  it("pauses the watch once for credits, keeps the video, and starts it after a resume", async () => {
    h.runs.create.mockRejectedValueOnce(
      new AppException(REPURPOSE_ERRORS.noCredits, "no credits", HttpStatus.PAYMENT_REQUIRED),
    );
    await h.poller.tick();
    expect(h.tables.sourceWatch[0]).toMatchObject({ state: "paused", stateReason: "no_credits" });
    expect(stateOf(h.tables, "vid00000002")).toBe("pending");
    expect(stateOf(h.tables, "vid00000004")).toBe("pending");
    expect(h.runs.create).toHaveBeenCalledTimes(1);
    expect(h.notices.paused).toHaveBeenCalledTimes(1);
    expect(h.notices.paused).toHaveBeenCalledWith(
      expect.anything(),
      "no_credits",
      expect.any(Date),
    );

    // Paused: later ticks read nothing and tell nobody again.
    h.at("2026-10-02T13:00:00Z");
    await h.poller.tick();
    expect(h.uploads).toHaveBeenCalledTimes(1);
    expect(h.notices.paused).toHaveBeenCalledTimes(1);

    // Resumed (what `SourceWatchService.resume` writes): the video goes first.
    Object.assign(h.tables.sourceWatch[0] as Row, {
      state: "active",
      stateReason: null,
      nextCheckAt: new Date("2026-10-02T13:00:00Z"),
    });
    await h.poller.tick();
    expect(stateOf(h.tables, "vid00000002")).toBe("started");
    expect(stateOf(h.tables, "vid00000004")).toBe("started");
  });

  it("leaves a video for later when the plan's lanes are full, without counting it against it", async () => {
    h.runs.create.mockRejectedValueOnce(
      new AppException("jobs/concurrency_cap", "busy", HttpStatus.TOO_MANY_REQUESTS),
    );
    await h.poller.tick();
    expect(h.tables.sourceWatchVideo.find((row) => row["videoId"] === "vid00000002")).toMatchObject(
      {
        state: "pending",
        attempts: 0,
      },
    );
    // The second video waits too: the lane that refused one refuses both.
    expect(h.runs.create).toHaveBeenCalledTimes(1);
    expect(h.tables.sourceWatch[0]?.["state"]).toBe("active");
  });

  it("gives a video up after three failures it cannot explain", async () => {
    h.feed([upload(2, "2026-10-01T06:00:00Z")]);
    h.runs.create.mockRejectedValue(new Error("database went away"));
    for (const time of ["2026-10-02T10:00:00Z", "2026-10-02T11:30:00Z", "2026-10-02T13:00:00Z"]) {
      h.at(time);
      await h.poller.tick();
    }
    expect(h.tables.sourceWatchVideo[0]).toMatchObject({
      state: "failed",
      reason: "start_failed",
      attempts: 3,
    });
    h.at("2026-10-02T15:00:00Z");
    await h.poller.tick();
    expect(h.runs.create).toHaveBeenCalledTimes(3);
  });

  it("records a refusal about the video itself as that video's failure and moves on", async () => {
    h.runs.create.mockRejectedValueOnce(
      new AppException("repurpose/source_invalid_url", "bad", HttpStatus.BAD_REQUEST),
    );
    await h.poller.tick();
    expect(h.tables.sourceWatchVideo.find((row) => row["videoId"] === "vid00000002")).toMatchObject(
      {
        state: "failed",
        reason: "repurpose/source_invalid_url",
      },
    );
    expect(stateOf(h.tables, "vid00000004")).toBe("started");
  });

  it("pauses a watch whose caption look has gone", async () => {
    h.runs.create.mockRejectedValueOnce(
      new AppException(REPURPOSE_ERRORS.styleUnknown, "gone", HttpStatus.BAD_REQUEST),
    );
    await h.poller.tick();
    expect(h.tables.sourceWatch[0]).toMatchObject({
      state: "paused",
      stateReason: "style_unknown",
    });
    expect(stateOf(h.tables, "vid00000002")).toBe("pending");
  });
});

describe("SourceWatchPoller: before it reads", () => {
  it("reads nothing for a workspace whose flags are off, and asks again in an hour", async () => {
    h.watches.enabled.mockResolvedValue(false);
    await h.poller.tick();
    expect(h.uploads).not.toHaveBeenCalled();
    expect((h.tables.sourceWatch[0]?.["nextCheckAt"] as Date).getTime()).toBe(
      new Date("2026-10-02T10:00:00Z").getTime() + WATCH_CHECK_EVERY_MS,
    );
  });

  it("pauses a watch whose person is no longer an editor, without reading", async () => {
    h.watches.canStartAs.mockResolvedValue(false);
    await h.poller.tick();
    expect(h.uploads).not.toHaveBeenCalled();
    expect(h.tables.sourceWatch[0]).toMatchObject({ state: "paused", stateReason: "creator_left" });
  });

  it("pauses a watch whose saved setup no longer passes", async () => {
    h = harness([
      watchRow({ setup: { ...SETUP, discovery: { ...SETUP.discovery, mode: "manual" } } }),
    ]);
    await h.poller.tick();
    expect(h.uploads).not.toHaveBeenCalled();
    expect(h.tables.sourceWatch[0]).toMatchObject({
      state: "paused",
      stateReason: "setup_invalid",
    });
  });

  it("stops the whole tick when YouTube is refusing, changing nothing", async () => {
    h = harness([
      watchRow(),
      watchRow({ id: "01JWATCH000000000000000002", channelId: "UCAnotherTestChannel0002" }),
    ]);
    h.uploads.mockRejectedValue(new ChannelLookupError("busy", "gate"));
    const report = await h.poller.tick();
    expect(report).toMatchObject({ busy: true, read: 0 });
    expect(h.uploads).toHaveBeenCalledTimes(1);
    expect(h.tables.sourceWatch.every((row) => row["checkFailures"] === 0)).toBe(true);
    expect(
      h.tables.sourceWatch.every(
        (row) => (row["nextCheckAt"] as Date).getTime() === CREATED.getTime(),
      ),
    ).toBe(true);
  });

  it("backs off after a failed read, and after three 'no such channel' says it has gone", async () => {
    h.uploads.mockRejectedValue(new ChannelLookupError("not_found", "404"));
    let time = new Date("2026-10-02T10:00:00Z").getTime();
    for (let i = 0; i < 3; i += 1) {
      h.at(new Date(time));
      await h.poller.tick();
      time = (h.tables.sourceWatch[0]?.["nextCheckAt"] as Date).getTime();
    }
    expect(h.tables.sourceWatch[0]).toMatchObject({
      state: "error",
      stateReason: "channel_not_found",
      checkFailures: 3,
      lastErrorCode: "channel_not_found",
    });
    expect(h.notices.paused).toHaveBeenCalledWith(
      expect.anything(),
      "channel_not_found",
      expect.any(Date),
    );
  });

  it("reads at most twenty feeds a tick, two seconds apart", async () => {
    const many = Array.from({ length: WATCHES_PER_TICK + 5 }, (_, i) =>
      watchRow({
        id: `01JWATCH${String(i).padStart(18, "0")}`,
        channelId: `UC${String(i).padStart(22, "0")}`,
      }),
    );
    h = harness(many);
    const report = await h.poller.tick();
    expect(report.read).toBe(WATCHES_PER_TICK);
    expect(h.uploads).toHaveBeenCalledTimes(WATCHES_PER_TICK);
    expect(h.sleep).toHaveBeenCalledTimes(WATCHES_PER_TICK - 1);
    expect(h.sleep).toHaveBeenCalledWith(WATCH_FETCH_SPACING_MS);
  });

  it("does not overlap itself", async () => {
    let release: () => void = () => undefined;
    h.uploads.mockImplementationOnce(
      async () =>
        new Promise<ChannelFeed>((resolve) => {
          release = () => {
            resolve(parseChannelFeed(feedXml([])));
          };
        }),
    );
    const first = h.poller.tick();
    await vi.waitFor(() => {
      expect(h.uploads).toHaveBeenCalledTimes(1);
    });
    expect(await h.poller.tick()).toMatchObject({ overlapped: true });
    release();
    await first;
  });

  it("starts nothing for a watch paused while its feed was being read", async () => {
    h.feed([upload(2, "2026-10-01T06:00:00Z")]);
    h.uploads.mockImplementationOnce(async () => {
      Object.assign(h.tables.sourceWatch[0] as Row, { state: "paused", stateReason: "person" });
      return parseChannelFeed(feedXml([upload(2, "2026-10-01T06:00:00Z")]));
    });
    await h.poller.tick();
    expect(stateOf(h.tables, "vid00000002")).toBe("pending");
    expect(h.runs.create).not.toHaveBeenCalled();
  });
});

describe("SourceWatchPoller: the latest videos asked for at creation", () => {
  it("starts the newest N of the back catalogue at the first read only", async () => {
    h = harness([watchRow({ backfillCount: 2 })]);
    h.feed([
      upload(1, "2026-09-01T00:00:00Z"),
      upload(2, "2026-09-10T00:00:00Z"),
      upload(3, "2026-09-20T00:00:00Z"),
    ]);
    await h.poller.tick();
    expect(
      videoRows(h.tables).map((row) => [row["videoId"], row["state"], row["backfill"]]),
    ).toEqual([
      ["vid00000002", "started", true],
      ["vid00000003", "started", true],
    ]);
    h.at("2026-10-02T12:00:00Z");
    await h.poller.tick();
    expect(h.tables.sourceWatchVideo).toHaveLength(2);
  });
});

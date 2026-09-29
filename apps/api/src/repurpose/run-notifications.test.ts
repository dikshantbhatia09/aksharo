import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AUTOPILOT_RETRY_AFTER_MS, AUTOPILOT_RUN_RETRIES } from "./repurpose.constants.js";
import {
  FAILED_NEWS_MS,
  REFUSALS_BEFORE_UPLOAD_NOTICE,
  RunNotifier,
  dueNotices,
} from "./run-notifications.js";

import type { ClipsProgress } from "./run-activity.js";
import type { NoticeFacts } from "./run-notifications.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { NotifyService } from "../notify/notify.service.js";
import type { NotifyEnqueueInput } from "../notify/notify.types.js";

/** The two collaborators the notifier reads through, as spies. */
interface Deps {
  readonly runs: {
    readonly flagEnabled: ReturnType<typeof vi.fn>;
    readonly blockedFetches: ReturnType<typeof vi.fn>;
  };
  readonly activity: { readonly clipsProgress: ReturnType<typeof vi.fn> };
}

const NOW = Date.parse("2026-09-29T12:00:00Z");
const WS = "01JWS00000000000000000000A";
const RUN = "01JRUN0000000000000000000A";
const USER = "01JUSER0000000000000000000";
const OWNER = "01JOWNER000000000000000000";

function clips(overrides: Partial<ClipsProgress> = {}): NonNullable<NoticeFacts["clips"]> {
  return {
    total: 0,
    ready: 0,
    usable: 0,
    cutting: 0,
    waiting: 0,
    captioned: { ready: 0, settled: 0 },
    formats: { total: 0, settled: 0 },
    images: { total: 0, settled: 0 },
    ...overrides,
  };
}

function facts(overrides: Partial<NoticeFacts> = {}): NoticeFacts {
  return {
    now: NOW,
    status: "materializing",
    failureCode: null,
    automation: "auto",
    autopilotRetries: 0,
    failedAt: null,
    candidateCount: 5,
    clips: null,
    sourceKeepsRefusing: false,
    ...overrides,
  };
}

const none = new Set<string>();
const names = (due: ReturnType<typeof dueNotices>) =>
  due.map((entry) => (entry.send ? entry.notice : `${entry.notice} (quiet)`));

describe("dueNotices: which news a run has for its person", () => {
  it("tells an Autopilot run's person when the first captioned video is ready, not before", () => {
    const cutOnly = facts({
      clips: clips({ total: 5, ready: 1, usable: 1, cutting: 1, waiting: 3 }),
    });
    expect(dueNotices(cutOnly, none)).toEqual([]);
    const captioned = facts({
      clips: clips({
        total: 5,
        ready: 2,
        usable: 2,
        cutting: 1,
        waiting: 2,
        captioned: { ready: 1, settled: 1 },
      }),
    });
    expect(dueNotices(captioned, none)).toEqual([
      { notice: "clips-ready", send: true, data: { count: 1 } },
    ]);
  });

  it("tells a manual run's person when a clip they asked for can be opened", () => {
    const due = dueNotices(
      facts({ automation: "manual", clips: clips({ total: 1, ready: 1, usable: 1 }) }),
      none,
    );
    expect(due).toEqual([{ notice: "clips-ready", send: true, data: { count: 1 } }]);
  });

  it("says everything is ready once every clip, size and image is made, and only that", () => {
    const done = facts({
      status: "review_ready",
      clips: clips({
        total: 4,
        ready: 3,
        usable: 3,
        captioned: { ready: 3, settled: 3 },
        formats: { total: 9, settled: 9 },
        images: { total: 3, settled: 3 },
      }),
    });
    expect(names(dueNotices(done, none))).toEqual(["clips-ready (quiet)", "run-complete"]);
    expect(dueNotices(done, none).at(-1)?.data).toEqual({ count: 3 });
    expect(names(dueNotices(done, new Set(["clips-ready"])))).toEqual(["run-complete"]);
    // One size still being made: not complete, and clips-ready still stands.
    const almost = facts({
      ...done,
      clips: clips({ ...done.clips, formats: { total: 9, settled: 8 } }),
    });
    expect(names(dueNotices(almost, none))).toEqual(["clips-ready"]);
  });

  it("never says complete for a run whose person picks the moments", () => {
    const manual = facts({
      status: "review_ready",
      automation: "manual",
      clips: clips({ total: 2, ready: 2, usable: 2 }),
    });
    expect(names(dueNotices(manual, none))).toEqual(["clips-ready"]);
  });

  it("asks for credits, or for the file, instead of just saying the run failed", () => {
    expect(
      dueNotices(facts({ status: "failed", failureCode: "repurpose/no_credits" }), none),
    ).toEqual([{ notice: "run-needs-you:credits", send: true, data: { reason: "credits" } }]);
    expect(
      dueNotices(facts({ status: "failed", failureCode: "repurpose/source_blocked" }), none),
    ).toEqual([{ notice: "run-needs-you:upload", send: true, data: { reason: "upload" } }]);
  });

  it("stays quiet about a failure Autopilot is about to try again, and speaks once it gives up", () => {
    const failed = {
      status: "failed" as const,
      failureCode: "repurpose/stage_timeout",
      failedAt: NOW - AUTOPILOT_RETRY_AFTER_MS,
    };
    expect(dueNotices(facts(failed), none)).toEqual([]);
    expect(
      names(dueNotices(facts({ ...failed, autopilotRetries: AUTOPILOT_RUN_RETRIES }), none)),
    ).toEqual(["run-failed"]);
    expect(names(dueNotices(facts({ ...failed, automation: "manual" }), none))).toEqual([
      "run-failed",
    ]);
    // Too long ago for Autopilot to retry by itself.
    expect(
      names(dueNotices(facts({ ...failed, failedAt: NOW - 2 * 24 * 60 * 60_000 }), none)),
    ).toEqual(["run-failed"]);
    // A refusal about the video itself is never retried.
    expect(
      names(dueNotices(facts({ status: "failed", failureCode: "repurpose/source_private" }), none)),
    ).toEqual(["run-failed"]);
  });

  it("offers the upload while YouTube keeps refusing, before the run gives up", () => {
    expect(
      names(dueNotices(facts({ status: "acquiring", sourceKeepsRefusing: true }), none)),
    ).toEqual(["run-needs-you:upload"]);
    expect(dueNotices(facts({ status: "acquiring" }), none)).toEqual([]);
    // Said once: the failure that follows is the same claim.
    expect(
      dueNotices(
        facts({ status: "failed", failureCode: "repurpose/source_blocked" }),
        new Set(["run-needs-you:upload"]),
      ),
    ).toEqual([]);
  });

  it("hands the moments over when they are the person's to pick, or to add", () => {
    expect(
      dueNotices(
        facts({ status: "candidates_ready", automation: "manual", candidateCount: 6 }),
        none,
      ),
    ).toEqual([{ notice: "run-needs-you:moments", send: true, data: { reason: "moments" } }]);
    expect(dueNotices(facts({ status: "candidates_ready", candidateCount: 0 }), none)).toEqual([
      { notice: "run-needs-you:moments", send: true, data: { reason: "add" } },
    ]);
    // Autopilot cuts the moments it found by itself.
    expect(dueNotices(facts({ status: "candidates_ready", candidateCount: 6 }), none)).toEqual([]);
  });

  it("has nothing to say about a run someone stopped", () => {
    expect(dueNotices(facts({ status: "cancelled" }), none)).toEqual([]);
  });
});

/** The notifier over fakes: the claims table is real enough to refuse a second insert. */
function harness(options: {
  runs: Record<string, unknown>[];
  flow?: boolean;
  clips?: NonNullable<NoticeFacts["clips"]>;
  gateOpenUntil?: number | null;
  refusals?: number;
  creatorIsMember?: boolean;
  enqueue?: (input: NotifyEnqueueInput) => Promise<unknown>;
}) {
  const claims = new Set<string>();
  const sent: NotifyEnqueueInput[] = [];
  const prisma = {
    repurposeRun: {
      findMany: vi.fn(async () =>
        options.runs.map((run) => ({
          ...run,
          notices: [...claims]
            .filter((key) => key.startsWith(`${String(run["id"])}|`))
            .map((key) => ({ kind: key.split("|")[1] })),
        })),
      ),
    },
    repurposeRunNotice: {
      create: vi.fn(async (args: { data: { runId: string; kind: string } }) => {
        const key = `${args.data.runId}|${args.data.kind}`;
        if (claims.has(key)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6",
          });
        }
        claims.add(key);
        return args.data;
      }),
    },
    user: {
      findFirst: vi.fn(async () =>
        options.creatorIsMember === false
          ? null
          : { id: USER, email: "asha@example.test", name: "Asha", locale: "hi-IN" },
      ),
    },
    workspace: {
      findFirst: vi.fn(async () => ({
        owner: {
          id: OWNER,
          email: "owner@example.test",
          name: null,
          locale: "en-IN",
          deletedAt: null,
        },
      })),
    },
  } as unknown as PrismaService;
  const deps: Deps = {
    runs: {
      flagEnabled: vi.fn(async () => options.flow ?? true),
      blockedFetches: vi.fn(async () => options.refusals ?? 0),
    },
    activity: { clipsProgress: vi.fn(async () => options.clips ?? clips()) },
  };
  const notify = {
    enqueue: vi.fn(async (input: NotifyEnqueueInput) => {
      sent.push(input);
      return options.enqueue === undefined ? { enqueued: true } : options.enqueue(input);
    }),
  } as unknown as NotifyService;
  const gate =
    options.gateOpenUntil === undefined
      ? undefined
      : { state: vi.fn(async () => ({ openUntil: options.gateOpenUntil ?? null })) };
  const make = () =>
    new RunNotifier(
      prisma,
      deps.runs as never,
      deps.activity as never,
      notify,
      { WEB_ORIGIN: "https://app.example.test" } as never,
      gate as never,
    );
  return { make, sent, claims, prisma, deps };
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN,
    workspaceId: WS,
    sourceKind: "youtube_url",
    status: "review_ready",
    failureCode: null,
    completedAt: null,
    createdBy: USER,
    createdAt: new Date(NOW - 3_600_000),
    config: { automation: "auto" },
    sourceTitle: "Diwali vlog",
    sourceProject: { title: "youtube.com · abc" },
    _count: { candidates: 4 },
    ...overrides,
  };
}

const COMPLETE = clips({
  total: 3,
  ready: 3,
  usable: 3,
  captioned: { ready: 3, settled: 3 },
  formats: { total: 9, settled: 9 },
  images: { total: 3, settled: 3 },
});

describe("RunNotifier: once per run and kind", () => {
  it("sends one 'everything is ready', however many passes and processes see it", async () => {
    const h = harness({ runs: [runRow()], clips: COMPLETE });
    const first = h.make();
    const second = h.make();
    // Two API processes, same moment, then the next pass of each.
    await Promise.all([first.sweep(NOW), second.sweep(NOW)]);
    await first.sweep(NOW + 30_000);
    await second.sweep(NOW + 60_000);

    expect(h.sent.map((input) => input.kind)).toEqual(["run-complete"]);
    expect([...h.claims].sort()).toEqual([`${RUN}|clips-ready`, `${RUN}|run-complete`]);
  });

  it("goes to the person who started the run, in their language, pointing at the run", async () => {
    const h = harness({ runs: [runRow()], clips: COMPLETE });
    await h.make().sweep(NOW);
    expect(h.sent[0]).toMatchObject({
      kind: "run-complete",
      to: "asha@example.test",
      locale: "hi-IN",
      userId: USER,
      workspaceId: WS,
      thread: RUN,
      idempotencyKey: `run-complete:${RUN}`,
      data: {
        count: 3,
        name: "Asha",
        video: "Diwali vlog",
        runId: RUN,
        link: `https://app.example.test/repurpose/${RUN}`,
      },
    });
  });

  it("goes to the workspace's owner when the person who started it has left, with the owner's own greeting", async () => {
    const h = harness({ runs: [runRow()], clips: COMPLETE, creatorIsMember: false });
    await h.make().sweep(NOW);
    expect(h.sent[0]?.to).toBe("owner@example.test");
    expect(h.sent[0]?.locale).toBe("en-IN");
    expect(h.sent[0]?.data).not.toHaveProperty("name");
  });

  it("tells a run that failed for good, and one that ran out of credits what to do", async () => {
    const h = harness({
      runs: [
        runRow({
          id: "01JRUNFAILED00000000000000",
          status: "failed",
          failureCode: "repurpose/source_private",
          completedAt: new Date(NOW - 60_000),
        }),
        runRow({
          id: "01JRUNCREDITS0000000000000",
          status: "failed",
          failureCode: "repurpose/no_credits",
          completedAt: new Date(NOW - 60_000),
        }),
      ],
    });
    await h.make().sweep(NOW);
    expect(h.sent.map((input) => [input.kind, input.data?.["reason"] ?? null])).toEqual([
      ["run-failed", null],
      ["run-needs-you", "credits"],
    ]);
  });

  it("offers the upload once YouTube has refused the download twice, while it waits", async () => {
    const early = runRow({ status: "acquiring", config: {} });
    const once = harness({ runs: [early], gateOpenUntil: NOW + 600_000, refusals: 1 });
    await once.make().sweep(NOW);
    expect(once.sent).toEqual([]);

    const twice = harness({
      runs: [early],
      gateOpenUntil: NOW + 600_000,
      refusals: REFUSALS_BEFORE_UPLOAD_NOTICE,
    });
    await twice.make().sweep(NOW);
    expect(twice.sent.map((input) => input.data?.["reason"])).toEqual(["upload"]);

    // With the gate closed nothing about an early run is even read.
    const closed = harness({ runs: [early], gateOpenUntil: null, refusals: 3 });
    await closed.make().sweep(NOW);
    expect(closed.deps.runs.blockedFetches).not.toHaveBeenCalled();
    expect(closed.sent).toEqual([]);
  });

  it("says nothing for a workspace whose clips surface is switched off", async () => {
    const h = harness({ runs: [runRow()], clips: COMPLETE, flow: false });
    await h.make().sweep(NOW);
    expect(h.sent).toEqual([]);
    expect(h.claims.size).toBe(0);
  });

  it("keeps the claim, and the pass going, when sending throws", async () => {
    const h = harness({
      runs: [runRow(), runRow({ id: "01JRUNSECOND00000000000000" })],
      clips: COMPLETE,
      enqueue: async () => {
        throw new Error("a notification needs a recipient address");
      },
    });
    await expect(h.make().sweep(NOW)).resolves.toBeUndefined();
    // Both runs were claimed and tried; neither is tried again.
    expect(h.sent).toHaveLength(2);
    await h.make().sweep(NOW + 30_000);
    expect(h.sent).toHaveLength(2);
  });

  it("does not read a run it has nothing left to tell", async () => {
    const h = harness({ runs: [runRow({ config: { automation: "manual" } })], clips: COMPLETE });
    await h.make().sweep(NOW);
    expect(h.sent.map((input) => input.kind)).toEqual(["clips-ready"]);
    await h.make().sweep(NOW + 30_000);
    // clips-ready is told, and a manual run is never "complete": no reads at all.
    expect(h.deps.activity.clipsProgress).toHaveBeenCalledTimes(1);
  });

  it("looks only at failures recent enough to be news", async () => {
    const h = harness({ runs: [] });
    await h.make().sweep(NOW);
    const where = (
      h.prisma.repurposeRun.findMany as unknown as { mock: { calls: [{ where: unknown }][] } }
    ).mock.calls[0]?.[0].where;
    expect(JSON.stringify(where)).toContain(new Date(NOW - FAILED_NEWS_MS).toISOString());
  });
});

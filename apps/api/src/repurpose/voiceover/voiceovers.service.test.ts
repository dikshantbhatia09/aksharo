import { beforeEach, describe, expect, it, vi } from "vitest";

import { quote, type Env } from "@montaj/config";
import { VOICEOVER_PACK_ID, stableOverlayId } from "@montaj/edg";
import { AiVoiceoverPayloadSchema, voiceoverAudioKey } from "@montaj/repurpose-contracts";

import { VOICEOVER_TENTHS, voiceoverVendorPaise } from "./voiceover-pricing.js";
import { VOICEOVER_ERRORS } from "./voiceover.constants.js";
import {
  RepurposeVoiceoversService,
  defaultHookOf,
  settledForVoice,
} from "./voiceovers.service.js";
import { AppException } from "../../common/index.js";
import { JOB_ERROR_CODES } from "../../jobs/jobs.errors.js";

import type { VoiceoverBudget } from "./voiceover-budget.js";
import type { CommonAuditService } from "../../common/audit/audit.service.js";
import type { PrismaService } from "../../common/index.js";
import type { ObjectStore } from "../../common/storage/index.js";
import type { EdgRepository, EdgService } from "../../edg/index.js";
import type { JobsService } from "../../jobs/jobs.service.js";
import type { EntitlementService } from "../../workspaces/entitlement.service.js";

const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const USER = "01JCUSER000000000000000000";
const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const CLIP = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const V916 = "01JCVAR1ANT916000000000000";
const V45 = "01JCVAR1ANT450000000000000";
const P916 = "01JCPR0JECT916000000000000";
const P45 = "01JCPR0JECT450000000000000";
const DOC916 = "01JCD0C916000000000000000A";
const DOC45 = "01JCD0C450000000000000000A";

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  for (const [key, condition] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(condition as Row[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection -- a test fake's own where-clause keys
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const op = condition as { in?: unknown[]; notIn?: unknown[]; not?: unknown; gte?: Date };
      if (op.in !== undefined && !op.in.includes(value)) return false;
      if (op.notIn !== undefined && op.notIn.includes(value)) return false;
      if ("not" in op && value === op.not) return false;
      if (op.gte !== undefined && !(value instanceof Date && value >= op.gte)) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

interface Tables {
  runs: Row[];
  clips: Row[];
  voiceovers: Row[];
  jobs: Row[];
  accounts: Row[];
  documents: Row[];
}

function table(rows: Row[], defaults: Row = {}) {
  return {
    findFirst: vi.fn(
      async (args: { where: Row }) => rows.find((r) => matches(r, args.where)) ?? null,
    ),
    findUnique: vi.fn(
      async (args: { where: Row }) => rows.find((r) => matches(r, args.where)) ?? null,
    ),
    findUniqueOrThrow: vi.fn(async (args: { where: Row }) => {
      const row = rows.find((r) => matches(r, args.where));
      if (row === undefined) throw new Error("not found");
      return row;
    }),
    findMany: vi.fn(async (args: { where?: Row } = {}) =>
      rows.filter((r) => matches(r, args.where)),
    ),
    count: vi.fn(
      async (args: { where?: Row } = {}) => rows.filter((r) => matches(r, args.where)).length,
    ),
    create: vi.fn(async (args: { data: Row }) => {
      const row = { createdAt: new Date(), updatedAt: new Date(), ...defaults, ...args.data };
      rows.push(row);
      return row;
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, args.where));
      for (const row of hit) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async (args: { where: Row }) => {
      const hit = rows.filter((r) => matches(r, args.where));
      for (const row of hit) rows.splice(rows.indexOf(row), 1);
      return { count: hit.length };
    }),
  };
}

function shape(
  id: string,
  aspect: string,
  project: string,
  doc: string | null,
  finishing?: Row,
  latestExportId: string | null = null,
) {
  return {
    id,
    aspect,
    projectId: project,
    finishing: finishing ?? null,
    latestExportId,
    project: {
      edgDocument: doc === null ? null : { id: doc, revision: 3 },
      transcripts: [{ language: "en" }],
    },
  };
}

function readyClip(overrides: Row = {}): Row {
  return {
    id: CLIP,
    runId: RUN,
    title: "The turbulence story",
    copy: { hook: "Nobody tells you this about turbulence" },
    mezzanineKey: `ws/${WS}/p/${SOURCE}/repurpose/${RUN}/clips/X/master.mp4`,
    mezzanineDurationMs: 30_000,
    sourceStartMs: 60_000,
    sourceEndMs: 90_000,
    candidate: { state: "selected" },
    variants: [shape(V916, "r9x16", P916, DOC916), shape(V45, "r4x5", P45, DOC45)],
    ...overrides,
  };
}

interface Harness {
  service: RepurposeVoiceoversService;
  t: Tables;
  jobs: { enqueue: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  budget: { reserve: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
  edg: { applyWorkerOps: ReturnType<typeof vi.fn> };
  /** Items each document holds, by document id. */
  items: Map<string, Row[]>;
  prisma: {
    clipVoiceover: ReturnType<typeof table>;
    $transaction: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };
}

let seq = 0;

function harness(
  flags: Record<string, boolean> = { repurpose_flow: true, repurpose_voiceover: true },
): Harness {
  const t: Tables = {
    runs: [
      {
        id: RUN,
        workspaceId: WS,
        sourceProjectId: SOURCE,
        status: "review_ready",
        config: { sourceLanguage: "auto" },
      },
    ],
    clips: [readyClip()],
    voiceovers: [],
    jobs: [],
    accounts: [{ workspaceId: WS, balanceTenths: 1_000 }],
    documents: [
      { id: DOC916, revision: 3 },
      { id: DOC45, revision: 3 },
    ],
  };
  const items = new Map<string, Row[]>([
    [DOC916, []],
    [DOC45, []],
  ]);
  const jobs = {
    enqueue: vi.fn(async (input: Row) => {
      seq += 1;
      const job = {
        id: `01JCJ0B${String(seq).padStart(19, "0")}`,
        status: "queued",
        params: input["params"],
        result: null,
        error: null,
      };
      t.jobs.push(job);
      return { job, deduplicated: false };
    }),
    cancel: vi.fn(async () => undefined),
  };
  const budget = {
    reserve: vi.fn(async () => ({ ok: true, day: "2026-10-01" })),
    release: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const docByProject = new Map([
    [P916, DOC916],
    [P45, DOC45],
  ]);
  const edg = {
    applyWorkerOps: vi.fn(async (input: { projectId: string; ops: Row[] }) => {
      const doc = docByProject.get(input.projectId) ?? "";
      const list = items.get(doc) ?? [];
      for (const op of input.ops) {
        if (op["type"] === "MergePass") {
          list.push(...((op["pass"] as Row)["items"] as Row[]));
        }
        if (op["type"] === "DecideItems") {
          for (const item of list) {
            if ((op["itemIds"] as string[]).includes(item["itemId"] as string)) {
              item["state"] = op["state"];
            }
          }
        }
      }
      return { applied: input.ops.map((op) => op["opId"]), rebased: [], rejected: [] };
    }),
  };
  const edgRepository = {
    projectionOf: vi.fn(async (docId: string) => ({
      media: [{ role: "primary", durationMs: 30_000 }],
      passes: [{ items: items.get(docId) ?? [] }],
    })),
  };
  const clipsTable = table(t.clips);
  // Interactive transactions run one at a time, as the clip's advisory lock
  // makes them in Postgres; the fake hands itself to the callback as `tx`.
  let lock: Promise<unknown> = Promise.resolve();
  const $executeRaw = vi.fn(async () => 1);
  const prisma = {
    $executeRaw,
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const turn = lock.then(() => callback(prisma));
      lock = turn.catch(() => undefined);
      return turn;
    }),
    repurposeRun: table(t.runs),
    repurposeClip: clipsTable,
    clipVoiceover: table(t.voiceovers, {
      attempts: 0,
      jobId: null,
      failureCode: null,
      failureMessage: null,
      audioKey: null,
      audioDurationMs: null,
      placements: {},
      completedAt: null,
    }),
    job: table(t.jobs),
    creditAccount: table(t.accounts),
    edgDocument: table(t.documents),
    clipVariant: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        (t.clips[0]?.["variants"] as Row[]).filter((v) =>
          args.where.id.in.includes(v["id"] as string),
        ),
      ),
    },
  };
  const derived = { presignGet: vi.fn(async (key: string) => `https://signed.test/${key}`) };
  const service = new RepurposeVoiceoversService(
    prisma as unknown as PrismaService,
    jobs as unknown as JobsService,
    { forWorkspace: async () => ({ entitlements: { flags } }) } as unknown as EntitlementService,
    audit as unknown as CommonAuditService,
    budget as unknown as VoiceoverBudget,
    edg as unknown as EdgService,
    edgRepository as unknown as EdgRepository,
    { FEATURE_FLAGS_JSON: {} } as unknown as Env,
    derived as unknown as ObjectStore,
  );
  return { service, t, jobs, budget, audit, edg, items, prisma };
}

async function refusal(promise: Promise<unknown>): Promise<AppException> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

const KEY = (id: string) =>
  voiceoverAudioKey({ workspaceId: WS, sourceProjectId: SOURCE, runId: RUN, voiceoverId: id });

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("RepurposeVoiceoversService.create (2026-10-01)", () => {
  it("asks for one ai.voiceover job with the clip's hook, in its language, holding 2 credits", async () => {
    const { voiceover, created } = await h.service.create(WS, USER, RUN, CLIP, {});

    expect(created).toBe(true);
    expect(voiceover.status).toBe("speaking");
    expect(voiceover.text).toBe("Nobody tells you this about turbulence");
    expect(voiceover.language.code).toBe("en-IN");
    expect(voiceover.speaker.id).toBe("anushka");
    const call = h.jobs.enqueue.mock.calls[0]?.[0] as Row;
    expect(call["type"]).toBe("ai.voiceover");
    expect(call["worstCaseTenths"]).toBe(VOICEOVER_TENTHS);
    const payload = AiVoiceoverPayloadSchema.parse(call["params"]);
    expect(payload.destination.key).toBe(KEY(voiceover.id));
    expect(payload.pace).toBe(1);
    expect(h.budget.reserve).toHaveBeenCalledWith(voiceoverVendorPaise(voiceover.text.length));
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.voiceover.requested" }),
    );
  });

  it("is refused while the flag is off, and never reaches the vendor", async () => {
    h = harness({ repurpose_flow: true });
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, {}));
    expect(error.code).toBe(VOICEOVER_ERRORS.notEnabled);
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.budget.reserve).not.toHaveBeenCalled();
  });

  it("is one voice-over for a repeated ask, and refuses a different one while it has one", async () => {
    const first = await h.service.create(WS, USER, RUN, CLIP, {});
    const again = await h.service.create(WS, USER, RUN, CLIP, {});
    expect(again.created).toBe(false);
    expect(again.voiceover.id).toBe(first.voiceover.id);
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, { text: "Something else" }));
    expect(error.code).toBe(VOICEOVER_ERRORS.alreadyHas);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses without credits before the budget is touched", async () => {
    h.t.accounts[0] = { workspaceId: WS, balanceTenths: 5 };
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, {}));
    expect(error.code).toBe(VOICEOVER_ERRORS.noCredits);
    expect(h.budget.reserve).not.toHaveBeenCalled();
  });

  it("refuses a clip with no words and none given", async () => {
    h.t.clips[0] = readyClip({ copy: {}, title: "Moment at 1:23–1:45" });
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, {}));
    expect(error.code).toBe(VOICEOVER_ERRORS.noText);
  });

  it("refuses a clip whose language the voice does not speak", async () => {
    const clip = readyClip();
    for (const variant of clip["variants"] as Row[]) {
      ((variant["project"] as Row)["transcripts"] as Row[])[0] = { language: "as" };
    }
    h.t.clips[0] = clip;
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, {}));
    expect(error.code).toBe(VOICEOVER_ERRORS.languageUnsupported);
  });

  it("waits for a full plan lane instead of failing", async () => {
    h.jobs.enqueue.mockRejectedValueOnce(
      new AppException(JOB_ERROR_CODES.concurrencyCap, "full", 429),
    );
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    expect(voiceover.status).toBe("waiting");
  });

  it("makes one voice-over for two different asks at once, and refuses the other", async () => {
    const results = await Promise.allSettled([
      h.service.create(WS, USER, RUN, CLIP, {}),
      h.service.create(WS, USER, RUN, CLIP, { text: "Something else entirely" }),
    ]);
    const made = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(made).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(((refused[0] as PromiseRejectedResult).reason as AppException).code).toBe(
      VOICEOVER_ERRORS.alreadyHas,
    );
    expect(h.t.voiceovers).toHaveLength(1);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    // Both reserved before the lock; the loser gave its rupees back.
    expect(h.budget.reserve).toHaveBeenCalledTimes(2);
    expect(h.budget.release).toHaveBeenCalledTimes(1);
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("answers the same ask made twice at once with one voice-over", async () => {
    const [first, second] = await Promise.all([
      h.service.create(WS, USER, RUN, CLIP, {}),
      h.service.create(WS, USER, RUN, CLIP, {}),
    ]);
    expect(first.voiceover.id).toBe(second.voiceover.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(h.t.voiceovers).toHaveLength(1);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(h.budget.release).toHaveBeenCalledTimes(1);
  });

  it("gives the rupees back and leaves nothing when the queue refuses", async () => {
    h.jobs.enqueue.mockRejectedValueOnce(new Error("redis down"));
    await refusal(h.service.create(WS, USER, RUN, CLIP, {}));
    expect(h.t.voiceovers).toHaveLength(0);
    expect(h.budget.release).toHaveBeenCalled();
  });
});

describe("applySpoken: the voice on every shape's document", () => {
  async function made(): Promise<{ id: string; jobId: string }> {
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const row = h.t.voiceovers[0] as Row;
    return { id: voiceover.id, jobId: row["jobId"] as string };
  }

  it("records the file, settles the price and lays one accepted cue on each shape", async () => {
    const { id, jobId } = await made();
    const tenths = await h.service.applySpoken(id, jobId, { key: KEY(id), durationMs: 2_400 });

    expect(tenths).toBe(VOICEOVER_TENTHS);
    const row = h.t.voiceovers[0] as Row;
    expect(row["status"]).toBe("ready");
    expect(row["placements"]).toEqual({
      [V916]: stableOverlayId(`${V916}:voiceover:${id}`),
      [V45]: stableOverlayId(`${V45}:voiceover:${id}`),
    });
    const cue = (h.items.get(DOC916) ?? [])[0] as Row;
    expect(cue["kind"]).toBe("sfx");
    expect(cue["state"]).toBe("accepted");
    expect(cue["startMs"]).toBe(0);
    expect(cue["endMs"]).toBe(2_400);
    const payload = cue["payload"] as Row;
    expect(payload["packId"]).toBe(VOICEOVER_PACK_ID);
    expect(payload["assetId"]).toBe(id);
    expect(payload["playThrough"]).toBe(true);
    expect(payload["dialogueDuck"]).toMatchObject({ depthDb: -14 });
  });

  it("is a no-op the second time, and never doubles a cue", async () => {
    const { id, jobId } = await made();
    await h.service.applySpoken(id, jobId, { key: KEY(id), durationMs: 2_400 });
    expect(await h.service.applySpoken(id, jobId, { key: KEY(id), durationMs: 2_400 })).toBe(0);
    expect(h.items.get(DOC916)).toHaveLength(1);
  });

  it("fails, places nothing and settles nothing for a file it did not ask for", async () => {
    const { id, jobId } = await made();
    const tenths = await h.service.applySpoken(id, jobId, {
      key: KEY(id).replace(RUN, "01ARZ3NDEKTSV4RRFFQ69G5FZZ"),
      durationMs: 2_400,
    });
    expect(tenths).toBe(0);
    expect((h.t.voiceovers[0] as Row)["status"]).toBe("failed");
    expect(h.items.get(DOC916)).toHaveLength(0);
  });

  it("waits for a shape still being finished, then places it on a later pass", async () => {
    const clip = readyClip();
    (clip["variants"] as Row[])[1] = shape(V45, "r4x5", P45, DOC45, {
      v: 1,
      state: "running",
      startedAt: "2026-10-01T10:00:00Z",
    });
    h.t.clips[0] = clip;
    const { id, jobId } = await made();
    await h.service.applySpoken(id, jobId, { key: KEY(id), durationMs: 2_400 });
    expect(h.items.get(DOC45)).toHaveLength(0);

    (clip["variants"] as Row[])[1] = shape(V45, "r4x5", P45, DOC45, {
      v: 1,
      state: "done",
      startedAt: "2026-10-01T10:00:00Z",
    });
    await h.service.reconcileRun(RUN, { placeAll: true });
    expect(h.items.get(DOC45)).toHaveLength(1);
  });
});

describe("Autopilot: the voice waits for the edit to be finished", () => {
  function autopilot(): void {
    (h.t.runs[0] as Row)["config"] = { sourceLanguage: "auto", automation: "auto" };
  }

  it("never lays the voice on a shape whose finishing has not started yet", async () => {
    autopilot();
    const clip = readyClip();
    h.t.clips[0] = clip;
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const jobId = (h.t.voiceovers[0] as Row)["jobId"] as string;
    await h.service.applySpoken(voiceover.id, jobId, { key: KEY(voiceover.id), durationMs: 2_000 });
    expect(h.items.get(DOC916)).toHaveLength(0);
    expect(h.items.get(DOC45)).toHaveLength(0);
    expect((h.t.voiceovers[0] as Row)["placements"]).toEqual({});

    // Finishing runs, then is done: now the voice goes on.
    const running = { v: 1, state: "running", startedAt: "2026-10-01T10:00:00Z", steps: {} };
    clip["variants"] = [
      shape(V916, "r9x16", P916, DOC916, running),
      shape(V45, "r4x5", P45, DOC45, running),
    ];
    await h.service.reconcileRun(RUN, { placeAll: true });
    expect(h.items.get(DOC916)).toHaveLength(0);

    const done = { ...running, state: "done", finishedAt: "2026-10-01T10:05:00Z" };
    clip["variants"] = [shape(V916, "r9x16", P916, DOC916, done), shape(V45, "r4x5", P45, DOC45)];
    await h.service.reconcileRun(RUN, { placeAll: true });
    expect(h.items.get(DOC916)).toHaveLength(1);
    // The 4:5 still has no record and no video: it waits.
    expect(h.items.get(DOC45)).toHaveLength(0);
  });

  it("lays it on an Autopilot shape made before finishing existed (a video, no record)", async () => {
    autopilot();
    h.t.clips[0] = readyClip({
      variants: [shape(V916, "r9x16", P916, DOC916, undefined, "01JCEXP0RT916000000000000A")],
    });
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const jobId = (h.t.voiceovers[0] as Row)["jobId"] as string;
    await h.service.applySpoken(voiceover.id, jobId, { key: KEY(voiceover.id), durationMs: 2_000 });
    expect(h.items.get(DOC916)).toHaveLength(1);
  });

  it("settledForVoice: running never, done always, no record only when nothing will finish it", () => {
    const running = { v: 1, state: "running", startedAt: "2026-10-01T10:00:00Z", steps: {} };
    const done = { ...running, state: "done" };
    expect(settledForVoice({ finishing: running, latestExportId: "x" }, false)).toBe(false);
    expect(settledForVoice({ finishing: done, latestExportId: null }, true)).toBe(true);
    expect(settledForVoice({ finishing: null, latestExportId: null }, false)).toBe(true);
    expect(settledForVoice({ finishing: null, latestExportId: null }, true)).toBe(false);
    expect(settledForVoice({ finishing: null, latestExportId: "x" }, true)).toBe(true);
  });
});

describe("failures, retries and taking it off", () => {
  it("gives the rupees back when the vendor refused the words, and offers no retry", async () => {
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const jobId = (h.t.voiceovers[0] as Row)["jobId"] as string;
    await h.service.applyJobFailed(voiceover.id, jobId, {
      code: "voiceover/vendor_refused",
      message: "text contains unsupported characters",
    });
    const row = h.t.voiceovers[0] as Row;
    expect(row["status"]).toBe("failed");
    expect(row["failureMessage"]).toBe("text contains unsupported characters");
    expect(h.budget.release).toHaveBeenCalledWith("2026-10-01", expect.any(Number));
    const error = await refusal(h.service.retry(WS, USER, RUN, voiceover.id));
    expect(error.code).toBe(VOICEOVER_ERRORS.notRetryable);
  });

  it("keeps the rupees counted after an outage, and tries again on Retry", async () => {
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const jobId = (h.t.voiceovers[0] as Row)["jobId"] as string;
    await h.service.applyJobFailed(voiceover.id, jobId, { code: "voiceover/vendor_unavailable" });
    expect(h.budget.release).not.toHaveBeenCalled();

    const retried = await h.service.retry(WS, USER, RUN, voiceover.id);
    expect(retried.status).toBe("speaking");
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(2);
    const keys = h.jobs.enqueue.mock.calls.map((call) => (call[0] as Row)["jobKey"]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("takes a made voice-over off every shape by rejecting its cue", async () => {
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const jobId = (h.t.voiceovers[0] as Row)["jobId"] as string;
    await h.service.applySpoken(voiceover.id, jobId, { key: KEY(voiceover.id), durationMs: 2_000 });

    const removed = await h.service.remove(WS, USER, RUN, voiceover.id);

    expect(removed.status).toBe("removed");
    expect(((h.items.get(DOC916) ?? [])[0] as Row)["state"]).toBe("rejected");
    expect(((h.items.get(DOC45) ?? [])[0] as Row)["state"]).toBe("rejected");
    // Off, a new one may be made.
    const next = await h.service.create(WS, USER, RUN, CLIP, { text: "A new line" });
    expect(next.created).toBe(true);
  });

  it("undoes the cues it laid when the voice-over is taken off while it is being laid", async () => {
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const jobId = (h.t.voiceovers[0] as Row)["jobId"] as string;
    const apply = h.edg.applyWorkerOps.getMockImplementation();
    if (apply === undefined) throw new Error("no fake");
    // The removal lands just as the first shape's cue is laid.
    h.edg.applyWorkerOps.mockImplementationOnce(
      async (input: { projectId: string; ops: Row[] }) => {
        const answer: unknown = await apply(input);
        await h.service.remove(WS, USER, RUN, voiceover.id);
        return answer;
      },
    );

    await h.service.applySpoken(voiceover.id, jobId, { key: KEY(voiceover.id), durationMs: 2_000 });

    const row = h.t.voiceovers[0] as Row;
    expect(row["status"]).toBe("removed");
    expect(row["placements"]).toEqual({});
    const laid = [...(h.items.get(DOC916) ?? []), ...(h.items.get(DOC45) ?? [])];
    expect(laid).toHaveLength(2);
    for (const item of laid) expect(item["state"]).toBe("rejected");
  });

  it("takes off cues recorded after its own read of the voice-over", async () => {
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    const jobId = (h.t.voiceovers[0] as Row)["jobId"] as string;
    await h.service.applySpoken(voiceover.id, jobId, { key: KEY(voiceover.id), durationMs: 2_000 });
    // A read made before the placement was recorded.
    h.prisma.clipVoiceover.findFirst.mockResolvedValueOnce({
      ...(h.t.voiceovers[0] as Row),
      placements: {},
    });

    await h.service.remove(WS, USER, RUN, voiceover.id);

    expect(((h.items.get(DOC916) ?? [])[0] as Row)["state"]).toBe("rejected");
    expect(((h.items.get(DOC45) ?? [])[0] as Row)["state"]).toBe("rejected");
  });

  it("stops one still being made, cancelling its job", async () => {
    const { voiceover } = await h.service.create(WS, USER, RUN, CLIP, {});
    await h.service.remove(WS, USER, RUN, voiceover.id);
    expect(h.jobs.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("list", () => {
  it("offers each clip's hook and says whether the feature is on", async () => {
    const view = await h.service.list(WS, RUN);
    expect(view.enabled).toBe(true);
    expect(view.tenthsPerVoiceover).toBe(VOICEOVER_TENTHS);
    expect(view.clips).toEqual([
      {
        clipId: CLIP,
        ready: true,
        text: "Nobody tells you this about turbulence",
        language: { code: "en-IN", name: "English" },
        voiceoverId: null,
        rerenderVideos: 0,
        rerenderTenths: 0,
      },
    ]);
    expect(view.renderTenthsPerMinute).toBe(quote("cloudRender", 1).costTenths);
  });

  it("says what making the clip's existing captioned videos again costs", async () => {
    h.t.clips[0] = readyClip({
      variants: [
        shape(V916, "r9x16", P916, DOC916, undefined, "01JCEXP0RT916000000000000A"),
        shape(V45, "r4x5", P45, DOC45, undefined, "01JCEXP0RT450000000000000A"),
      ],
    });
    const [offer] = (await h.service.list(WS, RUN)).clips;
    expect(offer?.rerenderVideos).toBe(2);
    // Each video is billed on its own, on the clip's 30 s.
    expect(offer?.rerenderTenths).toBe(2 * quote("cloudRender", 0.5).costTenths);
    expect(offer?.rerenderTenths).toBeGreaterThan(0);
  });

  it("reads off while the flag is", async () => {
    h = harness({ repurpose_flow: true });
    expect((await h.service.list(WS, RUN)).enabled).toBe(false);
  });
});

describe("defaultHookOf", () => {
  it("is the copy's hook, else the title, never an unnamed moment's label", () => {
    expect(defaultHookOf({ copy: { hook: "  Wait  for it " }, title: "T" })).toBe("Wait for it");
    expect(defaultHookOf({ copy: {}, title: "The story" })).toBe("The story");
    expect(defaultHookOf({ copy: {}, title: "Moment at 1:23–1:45" })).toBe("");
  });
});

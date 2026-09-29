import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";
import {
  AiDubPayloadSchema,
  MediaDubPayloadSchema,
  type DubTrack,
} from "@montaj/repurpose-contracts";

import { dubCostTenths, dubVendorPaise } from "./dub-pricing.js";
import { DUB_ERRORS } from "./dubs.constants.js";
import { RepurposeDubsService } from "./dubs.service.js";
import { AppException } from "../../common/index.js";
import { CreditsInsufficientError } from "../../credits/credits.facade.js";
import { JOB_ERROR_CODES } from "../../jobs/jobs.errors.js";

import type { DubBudget } from "./dub-budget.js";
import type { CommonAuditService } from "../../common/audit/audit.service.js";
import type { PrismaService } from "../../common/index.js";
import type { ObjectStore } from "../../common/storage/index.js";
import type { ExportsService } from "../../exports/exports.service.js";
import type { JobsService } from "../../jobs/jobs.service.js";
import type { EntitlementService } from "../../workspaces/entitlement.service.js";

const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const USER = "01JCUSER000000000000000000";
const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const CLIP = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const CANDIDATE = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CLIP_FOLDER = `ws/${WS}/p/${SOURCE}/repurpose/${RUN}/clips/${CANDIDATE}`;
const P916 = "01JCPR0JECT916000000000000";
const P45 = "01JCPR0JECT450000000000000";
const TRANSCRIPT = "01JCTRANSCR1PT000000000000";

type Row = Record<string, unknown>;

interface Tables {
  runs: Row[];
  clips: Row[];
  dubs: Row[];
  dubVariants: Row[];
  jobs: Row[];
  chunks: Row[];
  accounts: Row[];
  plan: string | null;
}

function matches(row: Row, where: Row | undefined): boolean {
  const fields = new Map(Object.entries(row));
  for (const [key, condition] of Object.entries(where ?? {})) {
    if (key === "dubId_language_aspect") {
      const composite = condition as Row;
      if (Object.entries(composite).some(([field, value]) => fields.get(field) !== value)) {
        return false;
      }
      continue;
    }
    const value = fields.get(key);
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const operator = condition as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
      if (operator.in !== undefined && !operator.in.includes(value)) return false;
      if (operator.notIn !== undefined && operator.notIn.includes(value)) return false;
      if ("not" in operator && value === operator.not) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function fakePrisma(t: Tables) {
  const table = (rows: Row[], expand: (row: Row) => Row = (row) => row) => ({
    findFirst: vi.fn(async (args: { where: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      return row === undefined ? null : expand(row);
    }),
    findUnique: vi.fn(async (args: { where: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      return row === undefined ? null : expand(row);
    }),
    findUniqueOrThrow: vi.fn(async (args: { where: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      if (row === undefined) throw new Error("not found");
      return expand(row);
    }),
    findMany: vi.fn(async (args: { where?: Row; take?: number } = {}) =>
      rows
        .filter((row) => matches(row, args.where))
        .slice(0, args.take ?? rows.length)
        .map(expand),
    ),
    count: vi.fn(
      async (args: { where?: Row } = {}) => rows.filter((row) => matches(row, args.where)).length,
    ),
    create: vi.fn(async (args: { data: Row }) => {
      const row = {
        createdAt: new Date(),
        updatedAt: new Date(),
        attempts: 0,
        jobId: null,
        vendorJobId: null,
        tracks: [],
        failureCode: null,
        failureMessage: null,
        completedAt: null,
        cancelledAt: null,
        ...args.data,
      };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: Row; data: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      if (row === undefined) throw new Error("not found");
      Object.assign(row, args.data, { updatedAt: new Date() });
      return row;
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, args.where));
      for (const row of hit) Object.assign(row, args.data, { updatedAt: new Date() });
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async (args: { where: Row }) => {
      const hit = rows.filter((row) => matches(row, args.where));
      for (const row of hit) rows.splice(rows.indexOf(row), 1);
      return { count: hit.length };
    }),
  });
  // The include the service reads a dub with: its shapes, as stored.
  const withShapes = (dub: Row): Row => ({
    ...dub,
    variants: t.dubVariants.filter((row) => row["dubId"] === dub["id"]),
  });
  return {
    repurposeRun: table(t.runs),
    repurposeClip: table(t.clips),
    clipDub: table(t.dubs, withShapes),
    clipDubVariant: table(t.dubVariants),
    job: table(t.jobs),
    jobEvent: { findMany: vi.fn(async () => []) },
    transcriptChunk: {
      findMany: vi.fn(async (args: { where: Row }) =>
        t.chunks.filter((row) => row["transcriptId"] === args.where["transcriptId"]),
      ),
    },
    creditAccount: table(t.accounts),
    subscription: {
      findFirst: vi.fn(async () => (t.plan === null ? null : { plan: { key: t.plan } })),
    },
  };
}

/** A ready clip with a 9:16 and a 4:5 shape, spoken in English. */
function readyClip(overrides: Row = {}): Row {
  const shape = (aspect: string, project: string, file: string) => ({
    aspect,
    layout: "single",
    captionConfig: { styleId: "punch-pop" },
    project: {
      id: project,
      mediaAssets: [
        {
          id: `${project.slice(0, 20)}MEDIA1`,
          status: "ready",
          storageKey: `${CLIP_FOLDER}/${file}`,
          durationMs: 34_000,
          facesKey: "faces.json",
          width: 1080,
          uploadedAt: new Date(),
        },
      ],
      transcripts: [{ id: TRANSCRIPT, language: "en" }],
    },
  });
  return {
    id: CLIP,
    runId: RUN,
    title: "The turbulence story",
    mezzanineKey: `${CLIP_FOLDER}/master.mp4`,
    mezzanineDurationMs: 34_000,
    candidate: { state: "selected" },
    variants: [shape("r9x16", P916, "master.mp4"), shape("r4x5", P45, "master-4x5.mp4")],
    ...overrides,
  };
}

interface Harness {
  service: RepurposeDubsService;
  t: Tables;
  jobs: { enqueue: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  budget: { reserve: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
  exports: { requestExport: ReturnType<typeof vi.fn> };
  flags: Record<string, boolean>;
}

let jobSeq = 0;

function harness(options: { flags?: Record<string, boolean> } = {}): Harness {
  const t: Tables = {
    runs: [
      {
        id: RUN,
        workspaceId: WS,
        sourceProjectId: SOURCE,
        status: "review_ready",
        createdBy: USER,
        config: { sourceLanguage: "auto" },
      },
    ],
    clips: [readyClip()],
    dubs: [],
    dubVariants: [],
    jobs: [],
    chunks: [],
    accounts: [{ workspaceId: WS, balanceTenths: 100_000 }],
    plan: "studio",
  };
  const flags = options.flags ?? { repurpose_flow: true, repurpose_dubbing: true };
  const jobs = {
    enqueue: vi.fn(async (input: Row) => {
      jobSeq += 1;
      const job = {
        id: `01JCJ0B${String(jobSeq).padStart(19, "0")}`,
        status: "queued",
        type: input["type"],
        jobKey: input["jobKey"],
        workspaceId: input["workspaceId"],
        params: input["params"],
        checkpoint: null,
      };
      t.jobs.push(job);
      return { job, deduplicated: false };
    }),
    cancel: vi.fn(async () => undefined),
  };
  const budget = {
    reserve: vi.fn(async () => ({ ok: true, day: "2026-10-04", spentPaise: 1 })),
    release: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const exports = {
    requestExport: vi.fn(async () => ({ exportId: "01JCEXP0RT0000000000000000" })),
  };
  const derived = {
    kind: "r2",
    presignGet: vi.fn(async (key: string) => `https://signed.test/${key}`),
  };
  const service = new RepurposeDubsService(
    fakePrisma(t) as unknown as PrismaService,
    jobs as unknown as JobsService,
    {
      forWorkspace: async () => ({ entitlements: { flags } }),
    } as unknown as EntitlementService,
    audit as unknown as CommonAuditService,
    budget as unknown as DubBudget,
    { FEATURE_FLAGS_JSON: {} } as unknown as Env,
    derived as unknown as ObjectStore,
    exports as unknown as ExportsService,
  );
  return { service, t, jobs, budget, audit, exports, flags };
}

async function refusal(promise: Promise<unknown>): Promise<AppException> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

function dubRow(overrides: Row = {}): Row {
  return {
    id: "01JCDVB0000000000000000000",
    runId: RUN,
    clipId: CLIP,
    workspaceId: WS,
    sourceLanguage: "en-IN",
    languages: ["hi-IN", "ta-IN"],
    status: "dubbing",
    failureCode: null,
    failureMessage: null,
    durationMs: 34_000,
    costTenths: dubCostTenths(34_000, 2),
    speakers: -1,
    vendorJobId: null,
    jobId: "01JCJ0BDUB00000000000000000".slice(0, 26),
    attempts: 1,
    tracks: [],
    budgetDay: "2026-10-04",
    budgetPaise: dubVendorPaise(34_000, 2),
    consentBy: USER,
    consentAt: new Date(),
    createdBy: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

const FOLDER = `ws/${WS}/p/${SOURCE}/repurpose/${RUN}/dubs/01JCDVB0000000000000000000`;

function readyTrack(language: "hi-IN" | "ta-IN"): DubTrack {
  return {
    language,
    status: "ready",
    audio: { key: `${FOLDER}/${language}/audio.mp3`, contentType: "audio/mpeg", sizeBytes: 10 },
    captions: { key: `${FOLDER}/${language}/captions.srt`, sizeBytes: 10 },
  };
}

// ---------------------------------------------------------------------------
// Asking for a dub
// ---------------------------------------------------------------------------

describe("create (2026-10-04)", () => {
  const ask = { languages: ["hi-IN", "ta-IN"] as ("hi-IN" | "ta-IN")[], consent: true };

  it("holds the request's credits on one ai.dub job, from the clip's clean 9:16 video", async () => {
    const { dub, created } = await h.service.create(WS, USER, RUN, CLIP, ask);

    expect(created).toBe(true);
    expect(dub.status).toBe("dubbing");
    expect(dub.languages.map((language) => [language.code, language.status])).toEqual([
      ["hi-IN", "dubbing"],
      ["ta-IN", "dubbing"],
    ]);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    const input = h.jobs.enqueue.mock.calls[0]?.[0] as Row;
    expect(input).toMatchObject({
      type: "ai.dub",
      workspaceId: WS,
      worstCaseTenths: dubCostTenths(34_000, 2),
      jobKey: `ai.dub:${dub.id}:1`,
    });
    const payload = AiDubPayloadSchema.parse(input["params"]);
    expect(payload).toMatchObject({
      action: "dub",
      source: { key: `${CLIP_FOLDER}/master.mp4`, contentType: "video/mp4" },
      sourceLanguage: "en-IN",
      targetLanguages: ["hi-IN", "ta-IN"],
      speakers: -1,
      durationMs: 34_000,
    });
    expect(payload.action === "dub" && payload.resumeVendorJobId).toBeUndefined();
    // The day's budget is charged the vendor's price, once.
    expect(h.budget.reserve).toHaveBeenCalledWith(dubVendorPaise(34_000, 2));
  });

  it("records who gave consent to clone the voice, and when, on the dub and in the audit log", async () => {
    const { dub } = await h.service.create(WS, USER, RUN, CLIP, ask);
    const row = h.t.dubs.find((entry) => entry["id"] === dub.id);
    expect(row?.["consentBy"]).toBe(USER);
    expect(row?.["consentAt"]).toBeInstanceOf(Date);
    const event = h.audit.record.mock.calls[0]?.[0] as Row;
    expect(event).toMatchObject({ action: "repurpose.dub.requested", actorId: USER });
    expect((event["data"] as Row)["consent"]).toMatchObject({
      by: USER,
      statement: "I have the right to use this speaker's voice, and consent to it being cloned.",
    });
  });

  it("refuses without the tick, and spends nothing", async () => {
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, { ...ask, consent: false }));
    expect(error.code).toBe(DUB_ERRORS.consentRequired);
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.budget.reserve).not.toHaveBeenCalled();
  });

  it("refuses while the flag is off for the workspace", async () => {
    h.flags["repurpose_dubbing"] = false;
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, ask));
    expect(error.code).toBe(DUB_ERRORS.notEnabled);
    expect(error.httpStatus).toBe(403);
  });

  it("answers 404 while the whole clips surface is off", async () => {
    h.flags["repurpose_flow"] = false;
    const error = await refusal(h.service.list(WS, RUN));
    expect(error.httpStatus).toBe(404);
  });

  it("refuses a clip that is not ready, removed, or in a language it cannot dub from", async () => {
    h.t.clips[0] = readyClip({ mezzanineKey: null });
    expect((await refusal(h.service.create(WS, USER, RUN, CLIP, ask))).code).toBe(
      DUB_ERRORS.clipNotReady,
    );
    h.t.clips[0] = readyClip({ candidate: { state: "rejected" } });
    expect((await refusal(h.service.create(WS, USER, RUN, CLIP, ask))).code).toBe(
      DUB_ERRORS.clipRemoved,
    );
    const french = readyClip();
    const variants = french["variants"] as Row[];
    ((variants[0] as Row)["project"] as Row)["transcripts"] = [{ id: TRANSCRIPT, language: "fr" }];
    h.t.clips[0] = french;
    expect((await refusal(h.service.create(WS, USER, RUN, CLIP, ask))).code).toBe(
      DUB_ERRORS.sourceUnsupported,
    );
    expect(h.budget.reserve).not.toHaveBeenCalled();
  });

  it("never dubs a clip into its own language", async () => {
    const error = await refusal(
      h.service.create(WS, USER, RUN, CLIP, { languages: ["en-IN"], consent: true } as never),
    );
    expect(error.code).toBe(DUB_ERRORS.sameLanguage);
  });

  it("answers the same request with the same dub, and refuses a language already taken", async () => {
    const first = await h.service.create(WS, USER, RUN, CLIP, ask);
    const again = await h.service.create(WS, USER, RUN, CLIP, {
      languages: ["ta-IN", "hi-IN"],
      consent: true,
    });
    expect(again).toMatchObject({ created: false });
    expect(again.dub.id).toBe(first.dub.id);
    const overlap = await refusal(
      h.service.create(WS, USER, RUN, CLIP, { languages: ["hi-IN", "bn-IN"], consent: true }),
    );
    expect(overlap.code).toBe(DUB_ERRORS.languageTaken);
    expect(overlap.details).toEqual({ languages: ["hi-IN"] });
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses a dub the balance cannot cover before any rupee is charged", async () => {
    h.t.accounts[0] = { workspaceId: WS, balanceTenths: 100 };
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, ask));
    expect(error.code).toBe(DUB_ERRORS.noCredits);
    expect(error.httpStatus).toBe(402);
    expect(h.budget.reserve).not.toHaveBeenCalled();
    expect(h.t.dubs).toHaveLength(0);
  });

  it("refuses a dub larger than the plan may hold at once, naming fewer languages", async () => {
    h.t.plan = null; // Free: 30 credits held at once; two languages of 34 s need 28.4, three 42.6.
    const error = await refusal(
      h.service.create(WS, USER, RUN, CLIP, {
        languages: ["hi-IN", "ta-IN", "bn-IN"],
        consent: true,
      }),
    );
    expect(error.code).toBe(DUB_ERRORS.planLimit);
  });

  it("refuses a fourth dub in motion, and one the day's budget cannot afford", async () => {
    for (const status of ["waiting", "dubbing", "dubbing"]) {
      h.t.dubs.push(
        dubRow({
          id: `01JCDVB${status}${String(h.t.dubs.length)}`.padEnd(26, "0"),
          status,
          clipId: "01JCOTHERC11P0000000000000",
          languages: ["hi-IN"],
        }),
      );
    }
    expect((await refusal(h.service.create(WS, USER, RUN, CLIP, ask))).code).toBe(
      DUB_ERRORS.tooMany,
    );
    h.t.dubs.length = 0;
    h.budget.reserve.mockResolvedValueOnce({
      ok: false,
      day: "2026-10-04",
      spentPaise: 49_000,
      capPaise: 50_000,
    });
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, ask));
    expect(error.code).toBe(DUB_ERRORS.budgetReached);
    expect(h.t.dubs).toHaveLength(0);
  });

  it("waits for a full lane rather than refusing, with the rupees kept", async () => {
    h.jobs.enqueue.mockRejectedValueOnce(
      new AppException(JOB_ERROR_CODES.concurrencyCap, "lane full", 429),
    );
    const { dub, created } = await h.service.create(WS, USER, RUN, CLIP, ask);
    expect(created).toBe(true);
    expect(dub.status).toBe("waiting");
    expect(dub.languages[0]?.status).toBe("queued");
    expect(h.budget.release).not.toHaveBeenCalled();
  });

  it("leaves nothing behind, and gives the rupees back, when the ledger refuses the hold", async () => {
    h.jobs.enqueue.mockRejectedValueOnce(new CreditsInsufficientError(40));
    const error = await refusal(h.service.create(WS, USER, RUN, CLIP, ask));
    expect(error.code).toBe(DUB_ERRORS.noCredits);
    expect(h.t.dubs).toHaveLength(0);
    expect(h.budget.release).toHaveBeenCalledWith("2026-10-04", dubVendorPaise(34_000, 2));
  });

  it("tells the vendor how many speak when diarisation found two, or the picture is stacked", async () => {
    h.t.chunks.push({
      transcriptId: TRANSCRIPT,
      chunkIdx: 0,
      revision: 1,
      words: [
        { wid: "0:0", s: 0, e: 1, t: "a", sp: "S1" },
        { wid: "0:1", s: 1, e: 2, t: "b", sp: "S2" },
      ],
    });
    await h.service.create(WS, USER, RUN, CLIP, { languages: ["hi-IN"], consent: true });
    const payload = AiDubPayloadSchema.parse((h.jobs.enqueue.mock.calls[0]?.[0] as Row)["params"]);
    expect(payload.action === "dub" && payload.speakers).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// What the vendor sends back
// ---------------------------------------------------------------------------

describe("the vendor's answer", () => {
  it("files the languages that came back, and settles on them alone", async () => {
    h.t.dubs.push(dubRow());
    const tenths = await h.service.applyDubbed(
      "01JCDVB0000000000000000000",
      dubRow()["jobId"] as string,
      {
        vendorJobId: "job-1",
        tracks: [readyTrack("hi-IN"), { language: "ta-IN", status: "failed", reason: "no" }],
      },
    );
    expect(tenths).toBe(dubCostTenths(34_000, 1));
    expect(h.t.dubs[0]).toMatchObject({ status: "making", vendorJobId: "job-1" });
  });

  it("fails a dub that came back with nothing, and charges nothing", async () => {
    h.t.dubs.push(dubRow());
    const tenths = await h.service.applyDubbed(
      "01JCDVB0000000000000000000",
      dubRow()["jobId"] as string,
      {
        vendorJobId: "job-1",
        tracks: [{ language: "hi-IN", status: "failed" }],
      },
    );
    expect(tenths).toBe(0);
    expect(h.t.dubs[0]).toMatchObject({ status: "failed", failureCode: DUB_ERRORS.vendorFailed });
  });

  it("changes nothing for another job's answer, or a dub no longer dubbing", async () => {
    h.t.dubs.push(dubRow({ status: "cancelled" }));
    expect(
      await h.service.applyDubbed("01JCDVB0000000000000000000", dubRow()["jobId"] as string, {
        vendorJobId: "job-1",
        tracks: [readyTrack("hi-IN")],
      }),
    ).toBe(0);
    expect(h.t.dubs[0]?.["status"]).toBe("cancelled");
  });

  it("fails with the vendor's own words, and gives the rupees back only when nothing started", async () => {
    h.t.dubs.push(dubRow());
    await h.service.applyJobFailed(
      "01JCDVB0000000000000000000",
      dubRow()["jobId"] as string,
      { code: "dub/vendor_refused", message: "Audio has no speech" },
      { vendorJobId: "job-1", vendorPhase: "created" },
    );
    expect(h.t.dubs[0]).toMatchObject({
      status: "failed",
      failureCode: "dub/vendor_refused",
      failureMessage: "Audio has no speech",
      vendorJobId: null,
      budgetPaise: 0,
    });
    expect(h.budget.release).toHaveBeenCalledWith("2026-10-04", dubVendorPaise(34_000, 2));
  });

  it("keeps a refused key's words off the page: they are about our key, not the clip", async () => {
    h.t.dubs.push(dubRow());
    await h.service.applyJobFailed(
      "01JCDVB0000000000000000000",
      dubRow()["jobId"] as string,
      { code: "dub/vendor_auth", message: "Sarvam refused the API key (401)." },
      { vendorJobId: "job-1", vendorPhase: "created" },
    );
    expect(h.t.dubs[0]).toMatchObject({
      status: "failed",
      failureCode: "dub/vendor_auth",
      failureMessage: null,
    });
  });

  it("keeps a started vendor job for Retry to resume, and its rupees counted", async () => {
    h.t.dubs.push(dubRow());
    await h.service.applyJobFailed(
      "01JCDVB0000000000000000000",
      dubRow()["jobId"] as string,
      { code: "dub/vendor_timeout", message: "internal words not for people" },
      { vendorJobId: "job-1", vendorPhase: "started" },
    );
    expect(h.t.dubs[0]).toMatchObject({
      status: "failed",
      failureCode: "dub/vendor_timeout",
      failureMessage: null,
      vendorJobId: "job-1",
    });
    expect(h.budget.release).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Retry and cancel
// ---------------------------------------------------------------------------

describe("retry", () => {
  it("resumes a vendor job that did not itself fail, and charges the budget nothing", async () => {
    h.t.dubs.push(
      dubRow({ status: "failed", failureCode: "dub/vendor_timeout", vendorJobId: "job-1" }),
    );
    const view = await h.service.retry(WS, USER, RUN, "01JCDVB0000000000000000000");
    expect(view.status).toBe("dubbing");
    const input = h.jobs.enqueue.mock.calls[0]?.[0] as Row;
    expect(input["jobKey"]).toBe("ai.dub:01JCDVB0000000000000000000:2");
    const payload = AiDubPayloadSchema.parse(input["params"]);
    expect(payload.action === "dub" && payload.resumeVendorJobId).toBe("job-1");
    expect(h.budget.reserve).not.toHaveBeenCalled();
  });

  it("starts a new vendor job after one that failed there, and charges the budget for it", async () => {
    h.t.dubs.push(
      dubRow({ status: "failed", failureCode: "dub/vendor_failed", vendorJobId: "job-1" }),
    );
    await h.service.retry(WS, USER, RUN, "01JCDVB0000000000000000000");
    const payload = AiDubPayloadSchema.parse((h.jobs.enqueue.mock.calls[0]?.[0] as Row)["params"]);
    expect(payload.action === "dub" && payload.resumeVendorJobId).toBeUndefined();
    expect(h.t.dubs[0]?.["vendorJobId"]).toBeNull();
    expect(h.budget.reserve).toHaveBeenCalledTimes(1);
  });

  it("refuses a dub the vendor refused, and one that did not fail", async () => {
    h.t.dubs.push(dubRow({ status: "failed", failureCode: "dub/vendor_refused" }));
    expect((await refusal(h.service.retry(WS, USER, RUN, "01JCDVB0000000000000000000"))).code).toBe(
      DUB_ERRORS.notRetryable,
    );
    h.t.dubs[0] = dubRow({ status: "ready" });
    expect((await refusal(h.service.retry(WS, USER, RUN, "01JCDVB0000000000000000000"))).code).toBe(
      DUB_ERRORS.notRetryable,
    );
  });
});

describe("cancel", () => {
  it("stops a dub with the vendor, and the vendor's job, and keeps its rupees counted", async () => {
    h.t.dubs.push(dubRow());
    h.t.jobs.push({
      id: dubRow()["jobId"],
      status: "running",
      checkpoint: { vendorJobId: "job-9", vendorPhase: "started" },
    });
    const view = await h.service.cancel(WS, USER, RUN, "01JCDVB0000000000000000000");
    expect(view.status).toBe("cancelled");
    expect(h.jobs.cancel).toHaveBeenCalledWith(dubRow()["jobId"], WS);
    const stop = h.jobs.enqueue.mock.calls[0]?.[0] as Row;
    expect(stop).toMatchObject({
      type: "ai.dub",
      skipAdmission: true,
      worstCaseTenths: 0,
      jobKey: "ai.dub.cancel:01JCDVB0000000000000000000:job-9",
    });
    expect(AiDubPayloadSchema.parse(stop["params"])).toMatchObject({
      action: "cancel",
      vendorJobId: "job-9",
    });
    expect(h.budget.release).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.dub.cancelled" }),
    );
  });

  it("gives the rupees back for a dub whose vendor job never started", async () => {
    h.t.dubs.push(dubRow({ status: "waiting", jobId: null }));
    await h.service.cancel(WS, USER, RUN, "01JCDVB0000000000000000000");
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.budget.release).toHaveBeenCalledWith("2026-10-04", dubVendorPaise(34_000, 2));
  });

  it("refuses once the vendor has finished", async () => {
    h.t.dubs.push(dubRow({ status: "making" }));
    expect(
      (await refusal(h.service.cancel(WS, USER, RUN, "01JCDVB0000000000000000000"))).code,
    ).toBe(DUB_ERRORS.notCancellable);
  });
});

// ---------------------------------------------------------------------------
// The reconcile: waiting, lost, and every shape in every language
// ---------------------------------------------------------------------------

describe("reconcileRun", () => {
  it("starts a waiting dub once the lane frees", async () => {
    h.t.dubs.push(dubRow({ status: "waiting", jobId: null, attempts: 0 }));
    await h.service.reconcileRun(RUN);
    expect(h.t.dubs[0]?.["status"]).toBe("dubbing");
    expect((h.jobs.enqueue.mock.calls[0]?.[0] as Row)["jobKey"]).toBe(
      "ai.dub:01JCDVB0000000000000000000:1",
    );
  });

  it("settles a dub whose job failed without its completion reaching the dub", async () => {
    h.t.dubs.push(dubRow());
    h.t.jobs.push({
      id: dubRow()["jobId"],
      status: "failed",
      error: { code: "jobs/stalled", message: "stopped responding" },
      checkpoint: null,
      result: null,
    });
    await h.service.reconcileRun(RUN);
    expect(h.t.dubs[0]).toMatchObject({ status: "failed", failureCode: "jobs/stalled" });
  });

  it("lays every language under every ready shape, each once", async () => {
    h.t.dubs.push(
      dubRow({
        status: "making",
        tracks: [readyTrack("hi-IN"), { language: "ta-IN", status: "failed" }],
      }),
    );
    await h.service.reconcileRun(RUN);

    const asked = h.jobs.enqueue.mock.calls.map((call) => call[0] as Row);
    expect(asked.map((input) => input["jobKey"])).toEqual([
      "media.dub:01JCDVB0000000000000000000:hi-IN:9x16",
      "media.dub:01JCDVB0000000000000000000:hi-IN:4x5",
    ]);
    const payload = MediaDubPayloadSchema.parse(asked[1]?.["params"]);
    expect(payload).toMatchObject({
      language: "hi-IN",
      shape: "4:5",
      video: { key: `${CLIP_FOLDER}/master-4x5.mp4`, durationMs: 34_000 },
      audio: { key: `${FOLDER}/hi-IN/audio.mp3` },
      destination: { key: `${FOLDER}/hi-IN/4x5.mp4` },
    });
    expect(asked.every((input) => input["worstCaseTenths"] === 0)).toBe(true);

    // The next pass asks for nothing new: both are under way.
    await h.service.reconcileRun(RUN);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(2);
  });

  it("captions a dubbed shape once its picture, document and face track are ready, then calls it made", async () => {
    h.t.dubs.push(
      dubRow({ status: "making", tracks: [readyTrack("hi-IN")], languages: ["hi-IN"] }),
    );
    const variant = (aspect: string, project: string): Row => ({
      id: `01JCDVBVAR${aspect}`.padEnd(26, "0").slice(0, 26),
      dubId: "01JCDVB0000000000000000000",
      language: "hi-IN",
      aspect,
      projectId: project,
      status: "preparing",
      editFingerprint: "",
      latestExportId: null,
      latestExport: null,
      project: {
        edgDocument: { revision: 3, updatedAt: new Date(Date.now() - 600_000) },
        mediaAssets: [
          {
            id: "m",
            status: "ready",
            storageKey: `${FOLDER}/hi-IN/${aspect === "r9x16" ? "9x16" : "4x5"}.mp4`,
            durationMs: 34_000,
            facesKey: "faces.json",
            width: 1080,
            uploadedAt: new Date(),
          },
        ],
        exports: [],
      },
    });
    h.t.dubVariants.push(
      variant("r9x16", "01JCDUBBEDPR0JECT916000000"),
      variant("r4x5", "01JCDUBBEDPR0JECT450000000"),
    );

    await h.service.reconcileRun(RUN);

    expect(h.exports.requestExport).toHaveBeenCalledTimes(2);
    expect(h.exports.requestExport.mock.calls[1]?.[0]).toMatchObject({
      projectId: "01JCDUBBEDPR0JECT450000000",
      preset: "instagram-feed",
      mode: "cloud",
    });
    expect(h.t.dubVariants.map((row) => [row["status"], row["editFingerprint"]])).toEqual([
      ["rendering", "edg:3"],
      ["rendering", "edg:3"],
    ]);
    expect(h.t.dubs[0]?.["status"]).toBe("making");

    // The renders land: each shape is made, and so is the dub.
    for (const row of h.t.dubVariants) {
      row["latestExport"] = { id: "e", status: "succeeded", storageKey: "ws/x/exports/e.mp4" };
    }
    await h.service.reconcileRun(RUN);
    expect(h.t.dubVariants.map((row) => row["status"])).toEqual(["ready", "ready"]);
    expect(h.t.dubs[0]?.["status"]).toBe("ready");
  });

  it("stops asking for shapes when the plan's lane is full, and asks again next time", async () => {
    h.t.dubs.push(dubRow({ status: "making", tracks: [readyTrack("hi-IN")] }));
    h.jobs.enqueue.mockRejectedValueOnce(
      new AppException(JOB_ERROR_CODES.concurrencyCap, "lane full", 429),
    );
    await h.service.reconcileRun(RUN);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    await h.service.reconcileRun(RUN);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// The list the page reads
// ---------------------------------------------------------------------------

describe("list", () => {
  it("offers each ready clip with its language, its length and the languages taken", async () => {
    h.t.dubs.push(dubRow({ languages: ["hi-IN"] }));
    const view = await h.service.list(WS, RUN);
    expect(view).toMatchObject({ enabled: true, tenthsPerMinute: 250 });
    expect(view.clips).toEqual([
      {
        clipId: CLIP,
        ready: true,
        sourceLanguage: { code: "en-IN", name: "English" },
        durationMs: 34_000,
        taken: ["hi-IN"],
      },
    ]);
    expect(view.dubs[0]?.canCancel).toBe(true);
    expect(view.languages.map((language) => language.code)).toContain("or-IN");
  });

  it("says when dubbing is off, and still shows the dubs already made", async () => {
    h.flags["repurpose_dubbing"] = false;
    h.t.dubs.push(dubRow({ status: "ready" }));
    const view = await h.service.list(WS, RUN);
    expect(view.enabled).toBe(false);
    expect(view.dubs).toHaveLength(1);
  });
});

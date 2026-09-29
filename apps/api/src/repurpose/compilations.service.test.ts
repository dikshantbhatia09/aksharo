import { beforeEach, describe, expect, it, vi } from "vitest";

import { quote, type Env } from "@montaj/config";
import { DEFAULT_BRAND_KIT_SETTINGS } from "@montaj/edg";
import { RenderCompilationPayloadSchema } from "@montaj/repurpose-contracts";

import { COMPILATION_ERRORS } from "./compilations.dto.js";
import { RepurposeCompilationsService } from "./compilations.service.js";
import { AppException } from "../common/index.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const SRC = "01JCSRCPR0JECT000000000000";
const CLIP_A = "01JCC11PA00000000000000000";
const CLIP_B = "01JCC11PB00000000000000000";
const CLIP_C = "01JCC11PC00000000000000000";

type Row = Record<string, unknown>;

interface Tables {
  runs: Row[];
  clips: Row[];
  compilations: Row[];
  exports: Row[];
  jobs: Row[];
}

function matches(row: Row, where: Row | undefined): boolean {
  const fields = new Map(Object.entries(row));
  for (const [key, condition] of Object.entries(where ?? {})) {
    if (key === "runId_fingerprint") {
      const { runId, fingerprint } = condition as Row;
      if (row["runId"] !== runId || row["fingerprint"] !== fingerprint) return false;
      continue;
    }
    const value = fields.get(key);
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const operator = condition as { in?: unknown[] };
      if (operator.in !== undefined) {
        if (!operator.in.includes(value)) return false;
        continue;
      }
    }
    if (value !== condition) return false;
  }
  return true;
}

/** Prisma's `data`: plain values, and `{ increment }` on a number. */
function applyData(row: Row, data: Row): void {
  const current = new Map(Object.entries(row));
  const next: Row = {};
  for (const [key, value] of Object.entries(data)) {
    const increment =
      value !== null && typeof value === "object"
        ? (value as { increment?: number }).increment
        : undefined;
    Object.assign(next, {
      [key]: increment === undefined ? value : (current.get(key) as number) + increment,
    });
  }
  Object.assign(row, next, { updatedAt: new Date() });
}

function fakePrisma(t: Tables) {
  // The columns' own defaults, as the database fills them in.
  const table = (rows: Row[], defaults: Row = {}) => ({
    findFirst: vi.fn(
      async (args: { where: Row }) => rows.find((row) => matches(row, args.where)) ?? null,
    ),
    findUnique: vi.fn(
      async (args: { where: Row }) => rows.find((row) => matches(row, args.where)) ?? null,
    ),
    findUniqueOrThrow: vi.fn(async (args: { where: Row }) => {
      const found = rows.find((row) => matches(row, args.where));
      if (found === undefined) throw new Error("not found");
      return found;
    }),
    findMany: vi.fn(async (args: { where?: Row; take?: number }) =>
      rows.filter((row) => matches(row, args.where)).slice(0, args.take ?? rows.length),
    ),
    create: vi.fn(async (args: { data: Row }) => {
      const row = { createdAt: new Date(), updatedAt: new Date(), ...defaults, ...args.data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: Row; data: Row }) => {
      const row = rows.find((entry) => matches(entry, args.where));
      if (row === undefined) throw new Error("not found");
      applyData(row, args.data);
      return row;
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, args.where));
      for (const row of hit) applyData(row, args.data);
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async (args: { where: Row }) => {
      const hit = rows.filter((row) => matches(row, args.where));
      for (const row of hit) rows.splice(rows.indexOf(row), 1);
      return { count: hit.length };
    }),
  });
  const exportsTable = table(t.exports, {
    storageKey: null,
    jobId: null,
    sizeBytes: null,
    durationMs: null,
    expiresAt: null,
  });
  return {
    repurposeRun: table(t.runs),
    repurposeClip: table(t.clips),
    repurposeCompilation: table(t.compilations, {
      sources: [],
      failureCode: null,
      jobId: null,
      exportId: null,
      attempts: 0,
    }),
    job: table(t.jobs),
    export: {
      ...exportsTable,
      // The foreign key: a compilation's export going sets it to null.
      deleteMany: vi.fn(async (args: { where: Row }) => {
        const result = await exportsTable.deleteMany(args);
        const gone = new Set(t.exports.map((row) => row["id"]));
        for (const compilation of t.compilations) {
          if (compilation["exportId"] !== null && !gone.has(compilation["exportId"])) {
            compilation["exportId"] = null;
          }
        }
        return result;
      }),
    },
  };
}

function video(clipId: string, suffix: string, durationMs: number, extra: Row = {}): Row {
  return {
    aspect: "r9x16",
    status: "ready",
    latestExport: {
      id: `01JCEXP0RT${suffix.padStart(16, "0")}`,
      status: "succeeded",
      storageKey: `ws/${WS}/p/01JCC11PPR0JECT0000000000${suffix.slice(-1)}/exports/01JCEXP0RT${suffix.padStart(16, "0")}.mp4`,
      durationMs,
      watermarked: false,
    },
    ...extra,
  };
}

let t: Tables;
let prisma: ReturnType<typeof fakePrisma>;
let jobs: { enqueue: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
let audit: { record: ReturnType<typeof vi.fn> };
let derived: { presignGet: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
let brandKits: { forClips: ReturnType<typeof vi.fn> };
let env: Env;
let jobCounter = 0;

function service(): RepurposeCompilationsService {
  return new RepurposeCompilationsService(
    prisma as never,
    jobs as never,
    {
      forWorkspace: vi.fn(async () => ({ entitlements: { flags: { repurpose_flow: true } } })),
    } as never,
    audit as never,
    env,
    derived as never,
    brandKits as never,
  );
}

beforeEach(() => {
  jobCounter = 0;
  t = {
    runs: [{ id: RUN, workspaceId: WS, sourceProjectId: SRC, status: "review_ready" }],
    clips: [
      {
        id: CLIP_A,
        runId: RUN,
        candidate: { state: "materialized" },
        variants: [video(CLIP_A, "1", 30_000)],
      },
      {
        id: CLIP_B,
        runId: RUN,
        candidate: { state: "materialized" },
        variants: [video(CLIP_B, "2", 28_000)],
      },
      {
        id: CLIP_C,
        runId: RUN,
        candidate: { state: "materialized" },
        variants: [video(CLIP_C, "3", 20_000, { status: "rendering" })],
      },
    ],
    compilations: [],
    exports: [],
    jobs: [],
  };
  prisma = fakePrisma(t);
  jobs = {
    enqueue: vi.fn(async (input: Row) => {
      jobCounter += 1;
      const job = {
        id: `01JCJ0B${String(jobCounter).padStart(19, "0")}`,
        status: "queued",
        progress: 0,
        ...input,
      };
      t.jobs.push(job);
      return { job, deduplicated: false };
    }),
    cancel: vi.fn(async () => ({})),
  };
  audit = { record: vi.fn(async () => undefined) };
  derived = {
    presignGet: vi.fn(async (key: string, _ttl: number, options?: { downloadFilename?: string }) =>
      options?.downloadFilename === undefined
        ? `https://signed/${key}`
        : `https://signed/${key}?dl`,
    ),
    delete: vi.fn(async () => undefined),
  };
  brandKits = { forClips: vi.fn(async () => null) };
  env = { FEATURE_FLAGS_JSON: {} } as unknown as Env;
});

describe("RepurposeCompilationsService.create (2026-10-03)", () => {
  it("files an export, asks for the render at the cloud rate, and says it is being made", async () => {
    const { compilation, created } = await service().create(WS, USER, RUN, {
      clipIds: [CLIP_B, CLIP_A],
      shape: "9:16",
      title: "  Best of  the week ",
    });
    expect(created).toBe(true);
    expect(compilation).toMatchObject({
      status: "rendering",
      shape: "9:16",
      title: "Best of the week",
      clipIds: [CLIP_B, CLIP_A],
      // 28 s + 30 s + a 2 s card, two fades of half a second.
      durationMs: 59_000,
      stale: false,
      canRetry: false,
    });

    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    const asked = jobs.enqueue.mock.calls[0]?.[0] as Row;
    expect(asked).toMatchObject({
      type: "render.compilation",
      workspaceId: WS,
      projectId: SRC,
      worstCaseTenths: quote("cloudRender", 59_000 / 60_000).holdTenths,
    });
    const payload = RenderCompilationPayloadSchema.parse(asked["params"]);
    expect(payload.clips.map((clip) => clip.clipId)).toEqual([CLIP_B, CLIP_A]);
    expect(payload).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      fadeMs: 500,
      projectId: SRC,
    });
    expect(payload.intro).toMatchObject({ title: "Best of the week", background: "#141217" });
    expect(asked["jobKey"]).toBe(`render.compilation:${compilation.id}:${payload.exportId}`);

    expect(t.exports).toHaveLength(1);
    expect(t.exports[0]).toMatchObject({
      id: payload.exportId,
      projectId: SRC,
      status: "rendering",
      preset: "compilation-9x16",
      resolution: "1080x1920",
      jobId: (t.jobs[0] as Row)["id"],
    });
    expect(t.compilations[0]).toMatchObject({ attempts: 1, exportId: payload.exportId });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.compilation.requested" }),
    );
  });

  it("answers the same clips, shape and title with the compilation already made", async () => {
    const input = { clipIds: [CLIP_A, CLIP_B], shape: "9:16" as const };
    const first = await service().create(WS, USER, RUN, input);
    const again = await service().create(WS, USER, RUN, { ...input, title: "   " });
    expect(again.created).toBe(false);
    expect(again.compilation.id).toBe(first.compilation.id);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    // Another order is another compilation.
    const other = await service().create(WS, USER, RUN, { ...input, clipIds: [CLIP_B, CLIP_A] });
    expect(other.created).toBe(true);
  });

  it("refuses clips with no captioned video in the shape, naming them, and keeps nothing", async () => {
    const refused = service().create(WS, USER, RUN, {
      clipIds: [CLIP_A, CLIP_C],
      shape: "9:16",
    });
    await expect(refused).rejects.toMatchObject({
      code: COMPILATION_ERRORS.clipsNotReady,
      details: { clipIds: [CLIP_C] },
    });
    await expect(
      service().create(WS, USER, RUN, { clipIds: [CLIP_A, CLIP_B], shape: "1:1" }),
    ).rejects.toMatchObject({ details: { clipIds: [CLIP_A, CLIP_B] } });
    expect(t.compilations).toEqual([]);
    expect(t.exports).toEqual([]);
  });

  it("refuses a join past fifteen minutes", async () => {
    for (const clip of t.clips.slice(0, 2)) {
      ((clip["variants"] as Row[])[0]?.["latestExport"] as Row)["durationMs"] = 8 * 60_000;
    }
    await expect(
      service().create(WS, USER, RUN, { clipIds: [CLIP_A, CLIP_B], shape: "9:16" }),
    ).rejects.toMatchObject({ code: COMPILATION_ERRORS.tooLong });
    expect(t.compilations).toEqual([]);
  });

  it("waits for a full lane, leaving no export behind, and starts once it frees", async () => {
    jobs.enqueue.mockRejectedValueOnce(
      new AppException(JOB_ERROR_CODES.concurrencyCap, "lane full", 429),
    );
    const { compilation } = await service().create(WS, USER, RUN, {
      clipIds: [CLIP_A, CLIP_B],
      shape: "9:16",
    });
    expect(compilation.status).toBe("waiting");
    expect(t.exports).toEqual([]);
    expect(t.compilations[0]).toMatchObject({ exportId: null, attempts: 0 });

    await service().reconcileRun(RUN);
    expect(t.compilations[0]).toMatchObject({ status: "rendering", attempts: 1 });
    expect(t.exports).toHaveLength(1);
  });

  it("leaves nothing when the credits refuse it, and says so", async () => {
    jobs.enqueue.mockRejectedValueOnce(new AppException("credits/insufficient", "no credits", 402));
    await expect(
      service().create(WS, USER, RUN, { clipIds: [CLIP_A, CLIP_B], shape: "9:16" }),
    ).rejects.toMatchObject({ code: "credits/insufficient" });
    expect(t.compilations).toEqual([]);
    expect(t.exports).toEqual([]);
  });

  it("dresses the title card in the brand kit", async () => {
    const logo = {
      assetId: "01JCASSET00000000000000000",
      format: "png" as const,
      width: 40,
      height: 20,
    };
    brandKits.forClips.mockResolvedValueOnce({
      settings: {
        ...DEFAULT_BRAND_KIT_SETTINGS,
        endCard: { ...DEFAULT_BRAND_KIT_SETTINGS.endCard, background: "#0a0a40", handle: "@me" },
      },
      logo,
    });
    await service().create(WS, USER, RUN, {
      clipIds: [CLIP_A, CLIP_B],
      shape: "9:16",
      title: "Hi",
    });
    const payload = RenderCompilationPayloadSchema.parse(
      (jobs.enqueue.mock.calls[0]?.[0] as Row)["params"],
    );
    expect(payload.intro).toMatchObject({ background: "#0a0a40", handle: "@me", logo });
  });

  it("is not there while the clips flow is off", async () => {
    env = { FEATURE_FLAGS_JSON: { repurpose_flow: false } } as unknown as Env;
    await expect(service().list(WS, RUN)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("making again, deleting, and reading", () => {
  async function made(): Promise<string> {
    const { compilation } = await service().create(WS, USER, RUN, {
      clipIds: [CLIP_A, CLIP_B],
      shape: "9:16",
    });
    return compilation.id;
  }

  it("makes a failed one again from the clips' current videos, replacing its export", async () => {
    const id = await made();
    const firstExport = t.exports[0]?.["id"];
    Object.assign(t.compilations[0] as Row, {
      status: "failed",
      failureCode: COMPILATION_ERRORS.failed,
    });
    Object.assign(t.exports[0] as Row, { status: "failed" });

    const view = await service().retry(WS, USER, RUN, id);
    expect(view.status).toBe("rendering");
    expect(t.exports.map((row) => row["id"])).not.toContain(firstExport);
    expect(t.exports).toHaveLength(1);
    expect(t.compilations[0]).toMatchObject({ attempts: 2, failureCode: null });
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
  });

  it("will not make a current, finished one again, but will once a clip changed", async () => {
    const id = await made();
    const exportRow = t.exports[0] as Row;
    Object.assign(exportRow, {
      status: "succeeded",
      storageKey: `ws/${WS}/p/${SRC}/exports/${String(exportRow["id"])}.mp4`,
      expiresAt: new Date("2026-10-10T00:00:00Z"),
    });
    Object.assign(t.compilations[0] as Row, { status: "ready" });

    await expect(service().retry(WS, USER, RUN, id)).rejects.toMatchObject({
      code: COMPILATION_ERRORS.notRetryable,
    });

    const listed = (await service().list(WS, RUN)).compilations[0];
    expect(listed).toMatchObject({
      status: "ready",
      stale: false,
      expiresAt: "2026-10-10T00:00:00.000Z",
      playUrl: `https://signed/${String(exportRow["storageKey"])}`,
      downloadUrl: `https://signed/${String(exportRow["storageKey"])}?dl`,
    });

    // Clip A's captions were edited: its captioned video is another file now.
    ((t.clips[0]?.["variants"] as Row[])[0]?.["latestExport"] as Row)["id"] =
      "01JCEXP0RTNEW0000000000000";
    const stale = (await service().list(WS, RUN)).compilations[0];
    expect(stale).toMatchObject({ stale: true, canRetry: true });
    const again = await service().retry(WS, USER, RUN, id);
    expect(again.status).toBe("rendering");
    // The old file went with its export.
    expect(derived.delete).toHaveBeenCalledWith(exportRow["storageKey"]);
  });

  it("reads a made one whose file retention deleted as expired, and lets it be made again", async () => {
    const id = await made();
    Object.assign(t.exports[0] as Row, { status: "succeeded", storageKey: null });
    Object.assign(t.compilations[0] as Row, { status: "ready" });
    const [view] = (await service().list(WS, RUN)).compilations;
    expect(view).toMatchObject({ id, status: "expired", canRetry: true, playUrl: null });
  });

  it("shows the render's progress while it runs", async () => {
    await made();
    Object.assign(t.jobs[0] as Row, { status: "running", progress: 42 });
    const [view] = (await service().list(WS, RUN)).compilations;
    expect(view?.progress).toBe(42);
  });

  it("deletes one, stopping its render and its file", async () => {
    const id = await made();
    await service().remove(WS, USER, RUN, id);
    expect(jobs.cancel).toHaveBeenCalledWith((t.jobs[0] as Row)["id"], WS);
    expect(t.compilations).toEqual([]);
    expect(t.exports).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.compilation.deleted" }),
    );
    await expect(service().get(WS, RUN, id)).rejects.toMatchObject({
      code: COMPILATION_ERRORS.notFound,
    });
  });

  it("settles one whose render ended without its completion reaching it", async () => {
    await made();
    Object.assign(t.jobs[0] as Row, {
      status: "failed",
      error: { code: "jobs/stalled", message: "lost", retryable: true },
    });
    await service().reconcileRun(RUN);
    expect(t.compilations[0]).toMatchObject({
      status: "failed",
      failureCode: COMPILATION_ERRORS.stalled,
    });
    expect(t.exports[0]).toMatchObject({ status: "failed" });
  });

  it("gives up waiting on a clip that is gone", async () => {
    jobs.enqueue.mockRejectedValueOnce(
      new AppException(JOB_ERROR_CODES.concurrencyCap, "lane full", 429),
    );
    await made();
    (t.clips[1] as Row)["candidate"] = { state: "rejected" };
    await service().reconcileRun(RUN);
    expect(t.compilations[0]).toMatchObject({
      status: "failed",
      failureCode: COMPILATION_ERRORS.sourceGone,
    });
  });
});

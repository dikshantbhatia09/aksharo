import { describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { RepurposeResultsService, linesOf } from "./run-results.service.js";

import type { CommonAuditService } from "../../common/audit/audit.service.js";
import type { PrismaService } from "../../common/index.js";
import type { EntitlementService } from "../../workspaces/entitlement.service.js";
import type { ClipFinishing } from "../clip-finishing.js";
import type { RepurposeService } from "../repurpose.service.js";

const WS = "01JWS00000000000000000000A";
const RUN = "01JRUN000000000000000000RA";
const COPY = {
  summary: "Why it works",
  hook: "Wait for it",
  cta: "",
  hashtags: ["#money"],
  locale: "en-IN",
  title: "Old title",
};

interface Harness {
  readonly service: RepurposeResultsService;
  readonly run: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly clip: Record<string, unknown>;
  readonly audits: unknown[];
  readonly removed: string[];
  readonly restored: string[];
}

function harness(
  options: {
    readonly automation?: "auto" | "manual";
    readonly flow?: boolean;
    readonly budget?: Partial<Awaited<ReturnType<RepurposeService["budgetView"]>>>;
    readonly words?: unknown[];
  } = {},
): Harness {
  const run: Record<string, unknown> = {
    id: RUN,
    workspaceId: WS,
    sourceProjectId: "PRJ",
    windowStartMs: null,
    config: { automation: options.automation ?? "auto" },
  };
  const candidate: Record<string, unknown> = {
    id: "CAND",
    runId: RUN,
    title: "Old title",
    copy: COPY,
    startMs: 1_000,
    endMs: 9_000,
  };
  const clip: Record<string, unknown> = {
    id: "CLIP",
    candidateId: "CAND",
    title: "Old title",
    copy: COPY,
  };
  const variants = [
    {
      id: "V1",
      clipId: "CLIP",
      projectId: "P1",
      aspect: "r9x16",
      finishing: { v: 1, state: "done", startedAt: "x", steps: {} },
      layout: "single",
    },
    {
      id: "V2",
      clipId: "CLIP",
      projectId: "P2",
      aspect: "r4x5",
      finishing: { v: 1, state: "running", startedAt: "x", steps: {} },
      layout: "single",
    },
  ];
  const audits: unknown[] = [];
  const removed: string[] = [];
  const restored: string[] = [];
  const prisma = {
    repurposeRun: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        where.id === RUN && where.workspaceId === WS ? run : null,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(run, data),
    },
    clipCandidate: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        where.id === "CAND" ? candidate : null,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(candidate, data),
    },
    repurposeClip: {
      findUnique: async () => clip,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(clip, data),
    },
    clipVariant: { findMany: async () => variants },
    transcript: { findFirst: async () => ({ id: "T" }) },
    transcriptChunk: { findMany: async () => [] },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma),
  };
  const finishing = {
    removeAutopilotHook: vi.fn(async (variant: { id: string }) => {
      removed.push(variant.id);
      return true;
    }),
    restoreAutopilotHook: vi.fn(async (_run: unknown, variant: { id: string }) => {
      restored.push(variant.id);
      return true;
    }),
  } as unknown as ClipFinishing;
  const runs = {
    budgetView: async () => ({
      windowMs: 20 * 60_000,
      planWindowMs: 20 * 60_000,
      maxSourceDurationMs: 12 * 60 * 60_000,
      availableTenths: 2_000,
      pendingTenths: 0,
      ...options.budget,
    }),
  } as unknown as RepurposeService;
  const entitlements = {
    forWorkspace: async () => ({
      entitlements: { flags: { repurpose_flow: options.flow ?? true } },
    }),
  } as unknown as EntitlementService;
  const audit = {
    record: async (event: unknown) => audits.push(event),
  } as unknown as CommonAuditService;
  const env = { FEATURE_FLAGS_JSON: {} } as unknown as Env;
  const service = new RepurposeResultsService(
    prisma as unknown as PrismaService,
    runs,
    finishing,
    entitlements,
    audit,
    env,
  );
  return { service, run, candidate, clip, audits, removed, restored };
}

describe("retitle", () => {
  it("renames the moment, its clip and the title in its words, as the person's", async () => {
    const h = harness();
    await expect(h.service.retitle(WS, "U", RUN, "CAND", "New title")).resolves.toEqual({
      candidateId: "CAND",
      title: "New title",
    });
    expect(h.candidate["title"]).toBe("New title");
    expect(h.clip["title"]).toBe("New title");
    expect(h.candidate["copy"]).toMatchObject({
      title: "New title",
      source: "person",
      hook: "Wait for it",
    });
    expect(h.clip["copy"]).toMatchObject({ title: "New title", source: "person" });
    expect(h.audits).toEqual([expect.objectContaining({ action: "repurpose.candidate.retitled" })]);
  });

  it("is not another workspace's moment", async () => {
    const h = harness();
    await expect(h.service.retitle("OTHER", "U", RUN, "CAND", "x")).rejects.toMatchObject({
      httpStatus: 404,
    });
    await expect(h.service.retitle(WS, "U", RUN, "NOPE", "x")).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

describe("setHookTitles", () => {
  it("off takes Autopilot's titles out of every shape and records the run as off", async () => {
    const h = harness();
    await expect(h.service.setHookTitles(WS, "U", RUN, false)).resolves.toEqual({
      enabled: false,
      changed: 2,
    });
    expect(h.removed).toEqual(["V1", "V2"]);
    expect(h.run["config"]).toMatchObject({ automation: "auto", hookTitles: false });
  });

  it("on puts them back on finished shapes; one still being finished gets it from its pass", async () => {
    const h = harness();
    await expect(h.service.setHookTitles(WS, "U", RUN, true)).resolves.toEqual({
      enabled: true,
      changed: 1,
    });
    expect(h.restored).toEqual(["V1"]);
    expect(h.run["config"]).toMatchObject({ hookTitles: true });
  });

  it("is refused on a run whose person makes the clips", async () => {
    const h = harness({ automation: "manual" });
    await expect(h.service.setHookTitles(WS, "U", RUN, false)).rejects.toMatchObject({
      code: "repurpose/hook_titles_manual",
    });
  });
});

describe("estimate", () => {
  it("prices an upload's length, and Autopilot's finished videos on top", async () => {
    const h = harness();
    const estimate = await h.service.estimate(WS, { durationMs: 10 * 60_000, automation: "auto" });
    expect(estimate).toMatchObject({
      processMs: 10 * 60_000,
      trimmed: false,
      processCredits: 10,
      creditsLeft: 200,
      // 10 minutes: 5 clips x 4 shapes x 45 s = 15 min at 0.5 credit.
      finishedVideos: { clips: 5, videos: 20, credits: 7.5 },
      totalCredits: 18,
    });
  });

  it("says when a video is longer than what would be processed", async () => {
    const h = harness({ budget: { windowMs: 8 * 60_000 } });
    const estimate = await h.service.estimate(WS, {
      durationMs: 30 * 60_000,
      automation: "manual",
    });
    expect(estimate).toMatchObject({
      processMs: 8 * 60_000,
      trimmed: true,
      processCredits: 8,
      finishedVideos: null,
    });
  });

  it("takes the plan's window for a link, whose length is not known yet", async () => {
    const h = harness();
    const estimate = await h.service.estimate(WS, { automation: "manual" });
    expect(estimate).toMatchObject({ processMs: 20 * 60_000, processCredits: 20, trimmed: false });
  });

  it("is not there while the clips surface is off", async () => {
    const h = harness({ flow: false });
    await expect(h.service.estimate(WS, { automation: "auto" })).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});

describe("linesOf", () => {
  const word = (t: string, s: number, e: number) => ({ wid: `${t}-${String(s)}`, t, s, e });

  it("breaks at a sentence end, at a pause and at fourteen words, on the original's clock", () => {
    const words = [
      word("This", 0, 200),
      word("is", 210, 300),
      word("the", 310, 400),
      word("point.", 410, 600),
      word("Then", 2_000, 2_200),
      word("more", 2_210, 2_400),
    ];
    expect(linesOf(words, 60_000)).toEqual([
      { startMs: 60_000, endMs: 60_600, text: "This is the point." },
      { startMs: 62_000, endMs: 62_400, text: "Then more" },
    ]);
    const long = Array.from({ length: 20 }, (_, index) =>
      word(`w${String(index)}`, index * 100, index * 100 + 90),
    );
    expect(linesOf(long).map((line) => line.text.split(" ").length)).toEqual([14, 6]);
  });
});

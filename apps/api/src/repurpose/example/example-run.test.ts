import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { EXAMPLE_RATE_LIMIT, RepurposeExampleController } from "./example-run.controller.js";
import { EXAMPLE_CACHE_MS, ExampleRunService, exampleClipOf } from "./example-run.service.js";
import { RATE_LIMIT_KEY } from "../../common/guards/rate-limit.guard.js";
import { ROLES_KEY } from "../../common/guards/roles.guard.js";
import { AppException } from "../../common/index.js";

import type { PrismaService } from "../../common/index.js";
import type { RepurposeClipItemView, RepurposeClipsService } from "../repurpose-clips.service.js";
import type { RepurposeService } from "../repurpose.service.js";

const OWNER_WS = "01JEXOWNERWS00000000000000";
const CALLER_WS = "01JEXCALLERWS0000000000000";
const RUN = "01JEXRUN000000000000000000";
const MEMBER = "01JEXMEMBER000000000000000";

function readyItem(
  id: string,
  candidateId: string,
  overrides: Partial<RepurposeClipItemView> = {},
): RepurposeClipItemView {
  return {
    id,
    candidateId,
    runId: RUN,
    title: `Clip ${id}`,
    state: "ready",
    failureCode: null,
    mezzanineKey: `ws/${OWNER_WS}/p/X/clip.mp4`,
    mezzanineUrl: "https://media.example/mezzanine",
    copy: { title: `Clip ${id}`, hook: "Wait", hashtags: ["#money"] },
    createdBy: MEMBER,
    variants: [{ id: "V", projectId: "PROJECT-OF-OWNER", aspect: "r9x16" }],
    captioned: {
      status: "ready",
      playUrl: `https://media.example/${id}.mp4`,
      downloadUrl: `https://media.example/${id}.mp4?download`,
      durationMs: 30_000,
    },
    formats: [
      {
        shape: "9:16",
        status: "ready",
        projectId: "PROJECT-OF-OWNER",
        captioned: {
          status: "ready",
          playUrl: `https://media.example/${id}.mp4`,
          downloadUrl: `https://media.example/${id}.mp4?download`,
          durationMs: 30_000,
        },
        cleanUrl: "https://media.example/clean.mp4",
      },
      {
        shape: "1:1",
        status: "preparing",
        projectId: null,
        captioned: null,
        cleanUrl: null,
      },
    ],
    images: {
      status: "ready",
      files: [
        {
          id: "vertical-image",
          width: 1080,
          height: 1920,
          items: [
            { url: "https://media.example/v.jpg", downloadUrl: "https://media.example/v.jpg?d" },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function candidateRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    runId: RUN,
    source: "ai",
    state: "proposed",
    rank: 1,
    startMs: 1_000,
    endMs: 31_000,
    startWordId: "w1",
    endWordId: "w9",
    title: `Moment ${id}`,
    transcriptExcerpt: "the words",
    potentialScore: 87,
    scoreBreakdown: { hook: 0.8, clarity: 0.7, note: "not a number" },
    reasons: [{ label: "hook", explanation: "Opens on a question", evidence: { wordId: "w1" } }],
    signals: { energy: 0.4 },
    signalVersion: 1,
    promptVersion: "p1",
    model: "sarvam-105b-conversations",
    featureVersion: "f1",
    copy: {},
    judgement: {
      standalone: 8,
      payoff: 7,
      humour: 3,
      model: "m",
      people: ["Ada"],
      notes: { hook: "Strong" },
      reviewer: MEMBER,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

function harness(
  options: {
    readonly runId?: string | null;
    readonly run?: Record<string, unknown> | null;
    readonly items?: RepurposeClipItemView[];
    readonly candidates?: Record<string, unknown>[];
  } = {},
) {
  const run =
    options.run === undefined
      ? {
          id: RUN,
          workspaceId: OWNER_WS,
          sourceProjectId: "SRC-PROJECT",
          sourceKind: "youtube_url",
          sourceTitle: "How compounding works",
          sourceDisplay: "youtube.com · abc",
          createdBy: MEMBER,
          rightsAttestedBy: MEMBER,
          windowStartMs: 60_000,
          windowEndMs: 660_000,
          sourceDurationMs: 2_000_000,
          config: { automation: "auto" },
          sourceProject: { title: "Owner's project" },
        }
      : options.run;
  const prisma = {
    repurposeRun: { findFirst: vi.fn(async () => run) },
    clipCandidate: {
      findMany: vi.fn(async () => options.candidates ?? [candidateRow("C1"), candidateRow("C2")]),
    },
    transcript: { findFirst: vi.fn(async () => ({ id: "T" })) },
    transcriptChunk: {
      findMany: vi.fn(async () => [
        {
          chunkIdx: 0,
          revision: 1,
          words: [
            { wid: "a", s: 1_000, e: 1_400, t: "Money" },
            { wid: "b", s: 1_500, e: 1_900, t: "grows." },
          ],
        },
      ]),
    },
  };
  const clips = {
    readClips: vi.fn(async () => options.items ?? [readyItem("K1", "C1"), readyItem("K2", "C2")]),
    listClips: vi.fn(),
    reconcileClips: vi.fn(),
  };
  const service = new ExampleRunService(
    prisma as unknown as PrismaService,
    clips as unknown as RepurposeClipsService,
  );
  let now = 1_000_000;
  service.now = () => now;
  service.runId = () => (options.runId === undefined ? RUN : options.runId);
  return {
    service,
    prisma,
    clips,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ExampleRunService", () => {
  it("is unavailable, and reads nothing, while no example run is set", async () => {
    const h = harness({ runId: null });
    expect(await h.service.view()).toEqual({ available: false });
    expect(h.prisma.repurposeRun.findFirst).not.toHaveBeenCalled();
  });

  it("is unavailable when the run cannot be shown (gone, or its workspace or project deleted)", async () => {
    const h = harness({ run: null });
    expect(await h.service.view()).toEqual({ available: false });
    expect(h.prisma.repurposeRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: RUN,
          workspace: { deletedAt: null },
          sourceProject: { deletedAt: null },
        },
      }),
    );
  });

  it("is unavailable when no clip of the run is finished with a captioned video", async () => {
    const h = harness({
      items: [
        readyItem("K1", "C1", { captioned: null }),
        readyItem("K2", "C2", { state: "cutting" }),
      ],
    });
    expect(await h.service.view()).toEqual({ available: false });
  });

  it("is unavailable rather than failing when the read throws", async () => {
    const h = harness();
    h.clips.readClips.mockRejectedValueOnce(new Error("db down"));
    expect(await h.service.view()).toEqual({ available: false });
  });

  it("reads the clips without the list's reconcile: a visit never moves the run's work on", async () => {
    const h = harness();
    await h.service.view();
    expect(h.clips.readClips).toHaveBeenCalledTimes(1);
    expect(h.clips.listClips).not.toHaveBeenCalled();
    expect(h.clips.reconcileClips).not.toHaveBeenCalled();
  });

  it("shows the finished clips, their moments, sizes, images and words", async () => {
    const h = harness();
    const view = await h.service.view();
    if (!view.available) throw new Error("expected the example");
    expect(view.run).toEqual({
      title: "How compounding works",
      source: "link",
      automation: "auto",
      processedMs: 600_000,
      clipCount: 2,
    });
    expect(view.clips.map((clip) => clip.id)).toEqual(["K1", "K2"]);
    const clip = view.clips[0];
    expect(clip?.captioned.playUrl).toBe("https://media.example/K1.mp4");
    // Only sizes with a finished video, and never a clean cut.
    expect(clip?.formats.map((format) => format.shape)).toEqual(["9:16"]);
    expect(clip?.formats[0]?.cleanUrl).toBeNull();
    expect(clip?.images.files[0]?.items[0]?.url).toBe("https://media.example/v.jpg");
    expect(view.candidates[0]).toMatchObject({
      id: "C1",
      potentialScore: 87,
      reasons: [{ label: "hook", explanation: "Opens on a question" }],
      scoreBreakdown: { hook: 0.8, clarity: 0.7 },
      judgement: { standalone: 8, payoff: 7, people: ["Ada"], notes: { hook: "Strong" } },
    });
    expect(view.transcripts["C1"]).toEqual({
      offsetMs: 60_000,
      lines: [{ startMs: 61_000, endMs: 61_900, text: "Money grows." }],
    });
  });

  it("carries no workspace, project, storage key, member or model-run detail", async () => {
    const h = harness();
    const text = JSON.stringify(await h.service.view());
    for (const secret of [
      OWNER_WS,
      MEMBER,
      "PROJECT-OF-OWNER",
      "SRC-PROJECT",
      "Owner's project",
      "ws/",
      "media.example/mezzanine",
      "clip.mp4",
      "clean.mp4",
      "reviewer",
      "promptVersion",
      "evidence",
      "signals",
      "workspaceId",
      "runId",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("leaves out a removed moment's clip", async () => {
    const h = harness({
      candidates: [candidateRow("C1"), candidateRow("C2", { state: "rejected" })],
    });
    const view = await h.service.view();
    if (!view.available) throw new Error("expected the example");
    expect(view.clips.map((clip) => clip.id)).toEqual(["K1"]);
    expect(view.candidates.map((candidate) => candidate.id)).toEqual(["C1"]);
  });

  it("serves one read to everyone for a minute, then reads again", async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.service.view(), h.service.view()]);
    expect(second).toBe(first);
    expect(h.clips.readClips).toHaveBeenCalledTimes(1);
    h.advance(EXAMPLE_CACHE_MS - 1);
    await h.service.view();
    expect(h.clips.readClips).toHaveBeenCalledTimes(1);
    h.advance(2);
    await h.service.view();
    expect(h.clips.readClips).toHaveBeenCalledTimes(2);
  });

  it("reads again at once when the owner names another run", async () => {
    const h = harness();
    await h.service.view();
    h.service.runId = () => "01JEXOTHERRUN0000000000000";
    await h.service.view();
    expect(h.clips.readClips).toHaveBeenCalledTimes(2);
  });

  it("calls a file run a file and falls back to a plain title", async () => {
    const h = harness({
      run: {
        id: RUN,
        workspaceId: OWNER_WS,
        sourceProjectId: "SRC-PROJECT",
        sourceKind: "upload",
        sourceTitle: null,
        windowStartMs: null,
        windowEndMs: null,
        sourceDurationMs: null,
        config: {},
        sourceProject: { title: "   " },
      },
    });
    const view = await h.service.view();
    if (!view.available) throw new Error("expected the example");
    expect(view.run).toMatchObject({
      title: "An example video",
      source: "file",
      automation: "manual",
      processedMs: null,
    });
  });
});

describe("exampleClipOf", () => {
  it("is null for a clip that is not ready", () => {
    expect(exampleClipOf(readyItem("K", "C", { state: "failed" }))).toBeNull();
  });
});

describe("RepurposeExampleController", () => {
  it("lets any member read it, rate-limited per person", () => {
    const reflector = new Reflector();
    const handler = RepurposeExampleController.prototype.get;
    expect(reflector.get<string[]>(ROLES_KEY, handler)).toEqual(["viewer"]);
    expect(reflector.get(RATE_LIMIT_KEY, handler)).toEqual([EXAMPLE_RATE_LIMIT]);
    expect(EXAMPLE_RATE_LIMIT.by).toBe("user");
  });

  it("checks the caller's workspace has the clips surface, never the example's", async () => {
    const runs = { assertAvailable: vi.fn(async () => undefined) };
    const example = { view: vi.fn(async () => ({ available: false as const })) };
    const controller = new RepurposeExampleController(
      example as unknown as ExampleRunService,
      runs as unknown as RepurposeService,
    );
    expect(await controller.get(CALLER_WS)).toEqual({ available: false });
    expect(runs.assertAvailable).toHaveBeenCalledWith(CALLER_WS);
  });

  it("answers 404 like the rest of the surface while it is off for the caller", async () => {
    const runs = {
      assertAvailable: vi.fn(async () => {
        throw new AppException("repurpose/not_available", "off", 404);
      }),
    };
    const example = { view: vi.fn() };
    const controller = new RepurposeExampleController(
      example as unknown as ExampleRunService,
      runs as unknown as RepurposeService,
    );
    await expect(controller.get(CALLER_WS)).rejects.toBeInstanceOf(AppException);
    expect(example.view).not.toHaveBeenCalled();
  });
});

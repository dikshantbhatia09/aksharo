import { describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { V1RunsController, setupFor } from "./v1-runs.controller.js";

import type { IdempotencyService } from "./idempotency.service.js";
import type { CommonAuditService } from "../../common/audit/audit.service.js";
import type { AuthPrincipal } from "../../common/guards/index.js";
import type { RepurposeClipsService } from "../../repurpose/repurpose-clips.service.js";
import type { RepurposeService } from "../../repurpose/repurpose.service.js";
import type { RepurposeResultsService } from "../../repurpose/results/run-results.service.js";
import type { RunSearch } from "../../repurpose/results/run-search.js";
import type { Request } from "express";

const WS = "01JWS00000000000000000000A";
const PRINCIPAL = { workspaceId: WS, userId: "01JOWNER0000000000000000AA" } as AuthPrincipal;

const RUN_VIEW = {
  id: "01JRUN000000000000000000RA",
  sourceTitle: "Diwali vlog",
  status: "transcribing",
  currentStage: "finding_clips",
  progress: 30,
  message: "Creating the transcript.",
  failureCode: null,
  automation: "auto",
  candidateCount: 0,
  clipCount: 0,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:01:00.000Z",
};

function harness(saved: unknown = null) {
  const created: unknown[] = [];
  const runs = {
    create: vi.fn(async (_ws: string, _user: string, input: unknown) => {
      created.push(input);
      return { run: RUN_VIEW, projectId: "P", upload: null };
    }),
    get: vi.fn(async () => RUN_VIEW),
    list: vi.fn(async () => ({ items: [RUN_VIEW], nextCursor: null })),
  } as unknown as RepurposeService;
  const clips = {
    listClips: vi.fn(async () => ({
      runId: RUN_VIEW.id,
      clips: [
        {
          id: "CLIP",
          candidateId: "CAND",
          title: "The aarti",
          state: "ready",
          failureCode: null,
          mezzanineUrl: "https://media.test/clean.mp4",
          captioned: { status: "ready", playUrl: "p", downloadUrl: "https://media.test/9x16.mp4" },
          formats: [
            {
              shape: "9:16",
              status: "ready",
              projectId: "P916",
              captioned: {
                status: "ready",
                playUrl: "p",
                downloadUrl: "https://media.test/9x16.mp4",
              },
              cleanUrl: "https://media.test/9x16-clean.mp4",
            },
            { shape: "1:1", status: "preparing", projectId: null, captioned: null, cleanUrl: null },
          ],
          images: { status: "ready", files: [{ id: "a", width: 1, height: 1, items: [{}, {}] }] },
          candidate: { potentialScore: 91, startMs: 1_000, endMs: 31_000 },
          variants: [{ projectId: "P916", aspect: "r9x16" }],
        },
      ],
    })),
  } as unknown as RepurposeClipsService;
  const results = {
    defaults: vi.fn(async () => ({ setup: saved, savedAt: null })),
    assertRun: vi.fn(async () => undefined),
  } as unknown as RepurposeResultsService;
  const finder = {
    search: vi.fn(async () => ({ semantic: true, matches: [{ candidateId: "CAND", score: 0.7 }] })),
  } as unknown as RunSearch;
  // No `Idempotency-Key`: the work runs straight through.
  const idempotency = {} as IdempotencyService;
  const audits: unknown[] = [];
  const audit = {
    record: async (event: unknown) => audits.push(event),
  } as unknown as CommonAuditService;
  const env = { WEB_ORIGIN: "https://app.aksharo.test" } as unknown as Env;
  const controller = new V1RunsController(runs, clips, results, finder, idempotency, audit, env);
  return { controller, created, audits, runs };
}

const request = { headers: {} } as unknown as Request;

describe("setupFor", () => {
  it("starts on Autopilot with Aksharo's defaults, changed by what the request says", () => {
    expect(
      setupFor(null, { url: "x", rightsAttested: true, clipLength: "short", topic: "money" }),
    ).toMatchObject({
      sourceLanguage: "auto",
      caption: { styleId: "punch-pop" },
      discovery: { mode: "ai", requestedCandidates: 5, clipLength: "short", topic: "money" },
      automation: "auto",
    });
  });

  it("starts on the workspace's saved setup, and never on hand-picked moments", () => {
    const saved = {
      sourceLanguage: "hi-Latn",
      caption: { outputLanguage: "same", scriptMode: "roman", styleId: "karaoke-fill" },
      discovery: { mode: "manual", requestedCandidates: 0 },
      automation: "manual",
      brand: true,
    } as unknown as Parameters<typeof setupFor>[0];
    expect(setupFor(saved, { url: "x", rightsAttested: true, autopilot: true })).toMatchObject({
      sourceLanguage: "hi-Latn",
      caption: { styleId: "karaoke-fill" },
      discovery: { mode: "ai", requestedCandidates: 5 },
      automation: "auto",
      brand: true,
    });
  });
});

describe("V1RunsController", () => {
  it("starts a run from a link, attested, and answers where it is", async () => {
    const h = harness();
    const run = await h.controller.start(request, PRINCIPAL, {
      url: "https://youtu.be/abc123def45",
      rightsAttested: true,
      startAtMs: 600_000,
    });
    expect(h.created[0]).toMatchObject({
      source: { kind: "url", url: "https://youtu.be/abc123def45", rightsAttested: true },
      setup: { window: { startMs: 600_000 }, automation: "auto" },
    });
    expect(run).toMatchObject({
      id: RUN_VIEW.id,
      title: "Diwali vlog",
      stage: "finding_clips",
      autopilot: true,
      appUrl: `https://app.aksharo.test/repurpose/${RUN_VIEW.id}`,
    });
    expect(h.audits[0]).toMatchObject({ action: "public_api.run.started", actorKind: "api" });
  });

  it("refuses a setup that does not pass, in plain words", async () => {
    const h = harness();
    await expect(
      h.controller.start(request, PRINCIPAL, {
        url: "https://youtu.be/abc123def45",
        rightsAttested: true,
        startAtMs: 48 * 60 * 60_000,
      }),
    ).rejects.toMatchObject({ code: "common/validation_failed", httpStatus: 400 });
    expect(h.created).toHaveLength(0);
  });

  it("lists a run's clips with every size's files and its place in the editor", async () => {
    const h = harness();
    const listed = await h.controller.listClips(PRINCIPAL, RUN_VIEW.id);
    expect(listed.clips[0]).toEqual({
      id: "CLIP",
      momentId: "CAND",
      title: "The aarti",
      score: 91,
      startMs: 1_000,
      endMs: 31_000,
      state: "ready",
      videos: [
        {
          shape: "9:16",
          status: "ready",
          captionedUrl: "https://media.test/9x16.mp4",
          cleanUrl: "https://media.test/9x16-clean.mp4",
        },
        { shape: "1:1", status: "preparing", captionedUrl: null, cleanUrl: null },
      ],
      images: 2,
      editorUrl: "https://app.aksharo.test/p/P916",
    });
  });

  it("finds moments by meaning", async () => {
    const h = harness();
    expect(await h.controller.search(PRINCIPAL, RUN_VIEW.id, { q: "money" })).toEqual({
      semantic: true,
      matches: [{ momentId: "CAND", score: 0.7 }],
    });
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RepurposeDubMuxCompletionHandler } from "./dub-mux-completion.handler.js";
import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";

import type { RepurposeDubsService } from "./dubs.service.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ObjectStore } from "../../common/storage/index.js";
import type { JobCompletionContext } from "../../jobs/completion-handlers.js";
import type { MediaService } from "../../media/media.service.js";
import type { ProjectsService } from "../../projects/projects.service.js";
import type { Job } from "@prisma/client";

const FIXTURES = resolve(process.cwd(), "..", "..", "packages", "repurpose-contracts", "fixtures");
function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a repository fixture
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

const PAYLOAD = fixture("media-dub-payload.v1.json");
const RESULT = fixture("media-dub-result.v1.json");
const DUB_ID = String(PAYLOAD["dubId"]);
const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const CAPTIONS = `${String(RESULT["key"]).replace("4x5.mp4", "captions.srt")}`;
const SRT =
  "1\n00:00:00,000 --> 00:00:02,000\nनमस्ते दोस्तों\n\n2\n00:00:02,500 --> 00:00:04,000\nचलिए\n";

type Row = Record<string, unknown>;

function harness(options: { srt?: string } = {}) {
  const variants: Row[] = [];
  const media: Row[] = [];
  const transcripts: Row[] = [];
  const chunks: Row[] = [];
  const dub = {
    id: DUB_ID,
    workspaceId: WS,
    createdBy: "01JCUSER000000000000000000",
    tracks: [
      {
        language: "hi-IN",
        status: "ready",
        audio: {
          key: String(PAYLOAD["audio"] && (PAYLOAD["audio"] as Row)["key"]),
          contentType: "audio/mpeg",
          sizeBytes: 10,
        },
        captions: { key: CAPTIONS, sizeBytes: 10 },
      },
    ],
    run: { createdBy: "01JCUSER000000000000000000", config: { caption: { styleId: "hype-bold" } } },
    clip: {
      title: "The turbulence story",
      variants: [{ aspect: "r4x5", captionConfig: { styleId: "punch-pop", styleVersion: 1 } }],
    },
  };
  const tx = {
    transcript: { create: vi.fn(async ({ data }: { data: Row }) => transcripts.push(data)) },
    transcriptChunk: { create: vi.fn(async ({ data }: { data: Row }) => chunks.push(data)) },
  };
  const prisma = {
    clipDub: { findUnique: vi.fn(async () => dub) },
    clipDubVariant: {
      findUnique: vi.fn(async () => variants[0] ?? null),
      findUniqueOrThrow: vi.fn(async () => variants[0]),
      create: vi.fn(async ({ data }: { data: Row }) => {
        variants.push(data);
        return data;
      }),
    },
    mediaAsset: {
      findFirst: vi.fn(async () => media[0] ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        media.push(data);
        return data;
      }),
      update: vi.fn(async ({ data }: { data: Row }) => Object.assign(media[0] ?? {}, data)),
    },
    transcript: { count: vi.fn(async () => transcripts.length) },
    project: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "01JCDUBBEDPR0JECT450000000",
        workspaceId: WS,
        status: "draft",
      })),
      delete: vi.fn(async () => undefined),
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<void>) => run(tx)),
  };
  const projects = {
    create: vi.fn(async () => ({ id: "01JCDUBBEDPR0JECT450000000" })),
  };
  const mediaService = {
    completeAcquisition: vi.fn(async ({ media: row }: { media: Row }) => {
      // The probe moves it on; a replay must not send it through again.
      Object.assign(row, { status: "uploaded" });
      return { media: row, probeJobId: "p" };
    }),
  };
  const raw = {
    kind: "s3",
    head: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  };
  const derived = {
    kind: "r2",
    head: vi.fn(async () => ({ sizeBytes: 100, contentType: "video/mp4" })),
    get: vi.fn(async (key: string) =>
      Buffer.from(key === CAPTIONS ? (options.srt ?? SRT) : "video-bytes", "utf8"),
    ),
  };
  const dubs = { reconcileDubSoon: vi.fn(async () => undefined) };
  const registry = new JobCompletionRegistry();
  const handler = new RepurposeDubMuxCompletionHandler(
    prisma as unknown as PrismaService,
    projects as unknown as ProjectsService,
    mediaService as unknown as MediaService,
    dubs as unknown as RepurposeDubsService,
    registry,
    raw as unknown as ObjectStore,
    derived as unknown as ObjectStore,
  );
  handler.onModuleInit();
  return {
    handler,
    registry,
    variants,
    media,
    transcripts,
    chunks,
    projects,
    mediaService,
    raw,
    dubs,
  };
}

function context(result: Row = RESULT): JobCompletionContext {
  return {
    job: { id: "01JCJ0BMUX0000000000000000", params: PAYLOAD } as unknown as Job,
    attemptId: "a",
    result,
    usage: undefined,
    completion: { status: "succeeded", result },
  };
}

describe("RepurposeDubMuxCompletionHandler (2026-10-04)", () => {
  it("owns media.dub completions", () => {
    expect(harness().registry.handlerFor("media.dub")).toBeInstanceOf(
      RepurposeDubMuxCompletionHandler,
    );
  });

  it("files the dubbed shape as its own project, in its language, on its clip's caption style", async () => {
    const h = harness();
    const outcome = await h.handler.handle(context());

    expect(h.projects.create).toHaveBeenCalledWith(WS, "01JCUSER000000000000000000", {
      title: "The turbulence story (4:5, Hindi)",
      sourceLanguage: "hi",
    });
    expect(h.variants[0]).toMatchObject({
      dubId: DUB_ID,
      language: "hi-IN",
      aspect: "r4x5",
      projectId: "01JCDUBBEDPR0JECT450000000",
      captionConfig: { styleId: "punch-pop", styleVersion: 1 },
      status: "preparing",
    });
    expect(h.media[0]).toMatchObject({
      role: "primary",
      status: "uploaded",
      storageKey: RESULT["key"],
      contentHash: RESULT["checksum"],
    });
    expect(outcome.data).toMatchObject({ applied: true, language: "hi-IN", shape: "4:5" });
    expect(h.dubs.reconcileDubSoon).toHaveBeenCalledWith(DUB_ID);
  });

  it("writes the new language's words from the vendor's captions before the pipeline starts", async () => {
    const h = harness();
    await h.handler.handle(context());
    expect(h.transcripts[0]).toMatchObject({ language: "hi" });
    const words = h.chunks[0]?.["words"] as { t: string; s: number; e: number }[];
    expect(words.map((word) => word.t)).toEqual(["नमस्ते", "दोस्तों", "चलिए"]);
    expect(words.every((word) => word.e > word.s && word.e <= 34_000)).toBe(true);
    expect(h.mediaService.completeAcquisition).toHaveBeenCalledTimes(1);
  });

  it("sends the dubbed video through the media pipeline once, however often it is told", async () => {
    const h = harness();
    await h.handler.handle(context());
    // The probe has it now; a replayed completion must not knock it back.
    Object.assign(h.media[0] ?? {}, { status: "probing" });
    await h.handler.handle(context());
    expect(h.projects.create).toHaveBeenCalledTimes(1);
    expect(h.mediaService.completeAcquisition).toHaveBeenCalledTimes(1);
    expect(h.transcripts).toHaveLength(1);
    expect(h.raw.put).toHaveBeenCalledTimes(1);
  });

  it("files nothing a worker reports for another shape, language or key", async () => {
    const h = harness();
    const outcome = await h.handler.handle(context({ ...RESULT, shape: "1:1" }));
    expect(outcome).toMatchObject({ actualTenths: 0, data: { applied: false } });
    expect(h.projects.create).not.toHaveBeenCalled();
  });

  it("leaves a shape with silent captions to be transcribed on its own", async () => {
    const h = harness({ srt: "" });
    await h.handler.handle(context());
    expect(h.transcripts).toHaveLength(0);
    expect(h.mediaService.completeAcquisition).toHaveBeenCalledTimes(1);
  });
});

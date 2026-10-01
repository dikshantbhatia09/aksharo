import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { ClipNleDownloadService } from "./nle-download.service.js";
import {
  IDS,
  cleanCut,
  guestHarness,
  seedClip,
  type GuestHarness,
} from "../guest/guest-memory.test-support.js";

import type { RedisService } from "../../common/redis/redis.service.js";
import type { ObjectStore } from "../../common/storage/index.js";
import type { EdgRepository } from "../../edg/edg.repository.js";

/**
 * "For your editing app" (2026-10-01): the single-use link and the streamed
 * ZIP, over the review module's in-memory database and fake store and Redis,
 * as "Download all"'s own service test does. The timeline rules themselves are
 * pinned in `nle-timeline.test.ts`.
 */

const EDG_ID = "01JEDG0000000000000000EDG1";
const TRANSCRIPT_ID = "01JTRN000000000000000TRN01";

interface Harness {
  readonly harness: GuestHarness;
  readonly service: ClipNleDownloadService;
  readonly objects: Map<string, Buffer>;
  readonly redis: Map<string, string>;
}

function setup(options: { readonly flow?: boolean } = {}): Harness {
  const harness = guestHarness(options.flow === false ? { flags: { repurpose_flow: false } } : {});
  const objects = new Map<string, Buffer>();
  const redis = new Map<string, string>();
  const store = {
    head: async (key: string) => {
      const data = objects.get(key);
      return data === undefined ? null : { sizeBytes: data.length, lastModified: null };
    },
    openRead: async (key: string) => {
      const data = objects.get(key);
      if (data === undefined) throw new Error(`no object ${key}`);
      return {
        sizeBytes: data.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(data));
            controller.close();
          },
        }),
      };
    },
  } as unknown as ObjectStore;
  const redisService = {
    client: {
      set: async (key: string, value: string) => {
        redis.set(key, value);
        return "OK";
      },
      getdel: async (key: string) => {
        const value = redis.get(key) ?? null;
        redis.delete(key);
        return value;
      },
    },
  } as unknown as RedisService;
  // The shape project's document: one accepted cut (1.0-2.0 s) and two captions.
  const edg = {
    projectionOf: async (id: string) => {
      if (id !== EDG_ID) throw new Error(`no document ${id}`);
      return {
        canvas: { width: 1080, height: 1920 },
        transcript: { transcriptId: TRANSCRIPT_ID },
        passes: [{ items: [{ kind: "cut", state: "accepted", startMs: 1000, endMs: 2000 }] }],
        segments: [
          { id: "s1", seq: 0, startWordId: "w1", endWordId: "w1", startMs: 0, endMs: 900 },
          { id: "s2", seq: 1, startWordId: "w2", endWordId: "w3", startMs: 2500, endMs: 4000 },
        ],
      };
    },
    loadChunks: async (transcriptId: string) => {
      if (transcriptId !== TRANSCRIPT_ID) throw new Error(`no transcript ${transcriptId}`);
      return [
        {
          chunkIdx: 0,
          words: [
            { wid: "w1", t: "Namaste", s: 0, e: 900 },
            { wid: "w2", t: "दीवाली", s: 2500, e: 3200 },
            { wid: "w3", t: "& <lights>", s: 3200, e: 4000 },
          ],
        },
      ];
    },
  } as unknown as EdgRepository;
  const env = {
    API_ORIGIN: "https://api.aksharo.test",
    WEB_ORIGIN: "https://aksharo.test",
  } as unknown as Env;
  const service = new ClipNleDownloadService(
    harness.db.prisma,
    redisService,
    harness.reviews,
    harness.audit,
    edg,
    store,
    env,
  );
  service.now = () => Date.parse("2026-10-05T06:00:00Z");
  return { harness, service, objects, redis };
}

/** A clip with a made 9:16 shape: its project, document and probed clean cut. */
function seedReady(h: Harness, options: { readonly store?: boolean } = {}): string {
  const db = h.harness.db;
  const clipId = seedClip(db, 1, { rendered: ["9:16"] });
  const key = cleanCut(db, clipId, "9:16");
  const media = db.tables.mediaAsset.find((row) => row["storageKey"] === key);
  if (media === undefined) throw new Error("no media");
  Object.assign(media, { durationMs: 5000, fps: 30, width: 1080, height: 1920, hasAudio: true });
  db.tables.project.push({
    id: media["projectId"],
    workspaceId: IDS.ws,
    deletedAt: null,
    title: "Clip 1 (9:16)",
    edgDocument: { id: EDG_ID },
  });
  if (options.store !== false) h.objects.set(key, Buffer.from("the clean cut's bytes"));
  return clipId;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

/** The ZIP's entries from its central directory (STORE only, as zip-writer writes). */
function entriesOf(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const localName = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    const data = zip.subarray(
      local + 30 + localName + localExtra,
      local + 30 + localName + localExtra + size,
    );
    expect(crc32(data)).toBe(crc);
    entries.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("ClipNleDownloadService", () => {
  it("hands out a single-use link whose ZIP holds the clean cut and three timeline files", async () => {
    const h = setup();
    const clipId = seedReady(h);
    const link = await h.service.createDownload(IDS.ws, IDS.viewer, IDS.run, clipId, "9:16");
    expect(link.url).toMatch(/^https:\/\/api\.aksharo\.test\/repurpose\/nle-downloads\/[\w-]{43}$/);
    expect(link.expiresAt).toBe("2026-10-05T06:05:00.000Z");
    // Only the token's hash is kept.
    const token = link.url.split("/").pop() ?? "";
    expect([...h.redis.keys()].some((key) => key.includes(token))).toBe(false);

    const opened = await h.service.open(token);
    expect(opened.filename).toBe("Clip 1 9x16 for editing.zip");
    const zip = await collect(opened.stream);
    expect(zip.length).toBe(opened.totalBytes);
    const entries = entriesOf(zip);
    expect([...entries.keys()].sort()).toEqual(
      [
        "Clip 1 9x16 for editing/Clip 1 9x16 Premiere.xml",
        "Clip 1 9x16 for editing/Clip 1 9x16.fcpxml",
        "Clip 1 9x16 for editing/Clip 1 9x16.mp4",
        "Clip 1 9x16 for editing/Clip 1 9x16.srt",
        "Clip 1 9x16 for editing/Read me.txt",
      ].sort(),
    );
    expect(entries.get("Clip 1 9x16 for editing/Clip 1 9x16.mp4")?.toString()).toBe(
      "the clean cut's bytes",
    );
    const fcpxml = entries.get("Clip 1 9x16 for editing/Clip 1 9x16.fcpxml")?.toString() ?? "";
    expect(fcpxml).toContain('<event name="Diwali vlog">');
    expect(fcpxml).toContain("दीवाली &amp; &lt;lights&gt;");
    // The cut 1-2 s is repeated: two stretches, 4 s in all.
    expect(fcpxml).toContain('<sequence format="r1" duration="4s"');
    const srt = entries.get("Clip 1 9x16 for editing/Clip 1 9x16.srt")?.toString() ?? "";
    // 2.5-4.0 s of the clean cut is 1.5-3.0 s of the timeline.
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:03,000\nदीवाली & <lights>");

    expect(h.harness.audits).toContainEqual(
      expect.objectContaining({
        action: "repurpose.clip.nle_downloaded",
        resourceId: clipId,
        actorId: IDS.viewer,
        data: expect.objectContaining({ shape: "9:16", captions: 2, edits: 1 }),
      }),
    );

    // Spent on first use.
    await expect(h.service.open(token)).rejects.toMatchObject({
      code: "repurpose/download_expired",
    });
  });

  it("refuses a malformed or unknown token without touching Redis state", async () => {
    const h = setup();
    await expect(h.service.open("not-a-token")).rejects.toMatchObject({
      code: "repurpose/download_expired",
    });
    await expect(h.service.open("A".repeat(43))).rejects.toMatchObject({
      code: "repurpose/download_expired",
    });
  });

  it("says not ready for a shape that was never made, and 404s another run's clip", async () => {
    const h = setup();
    const clipId = seedReady(h);
    await expect(
      h.service.createDownload(IDS.ws, IDS.viewer, IDS.run, clipId, "16:9"),
    ).rejects.toMatchObject({ code: "repurpose/nle_not_ready" });
    await expect(
      h.service.createDownload(IDS.ws, IDS.viewer, IDS.otherRun, clipId, "9:16"),
    ).rejects.toMatchObject({ code: "repurpose/not_found" });
    await expect(
      h.service.createDownload(IDS.otherWs, IDS.viewer, IDS.run, clipId, "9:16"),
    ).rejects.toMatchObject({ code: "repurpose/not_found" });
    expect(h.redis.size).toBe(0);
  });

  it("says not ready while the shape has no editing document or probed length", async () => {
    const h = setup();
    const clipId = seedReady(h);
    const project = h.harness.db.tables.project.find((row) => row["edgDocument"] !== undefined);
    if (project === undefined) throw new Error("no project");
    project["edgDocument"] = null;
    await expect(
      h.service.createDownload(IDS.ws, IDS.viewer, IDS.run, clipId, "9:16"),
    ).rejects.toMatchObject({ code: "repurpose/nle_not_ready" });
    project["edgDocument"] = { id: EDG_ID };
    const media = h.harness.db.tables.mediaAsset[0];
    if (media === undefined) throw new Error("no media");
    media["durationMs"] = null;
    await expect(
      h.service.createDownload(IDS.ws, IDS.viewer, IDS.run, clipId, "9:16"),
    ).rejects.toMatchObject({ code: "repurpose/nle_not_ready" });
  });

  it("refuses a removed moment's clip", async () => {
    const h = setup();
    const clipId = seedReady(h);
    const candidate = h.harness.db.tables.clipCandidate[0];
    if (candidate === undefined) throw new Error("no candidate");
    candidate["state"] = "rejected";
    await expect(
      h.service.createDownload(IDS.ws, IDS.viewer, IDS.run, clipId, "9:16"),
    ).rejects.toMatchObject({ code: "repurpose/not_found" });
  });

  it("is not ready when the clean cut is gone from the store by the time the link is used", async () => {
    const h = setup();
    const clipId = seedReady(h, { store: false });
    const link = await h.service.createDownload(IDS.ws, IDS.viewer, IDS.run, clipId, "9:16");
    await expect(h.service.open(link.url.split("/").pop() ?? "")).rejects.toMatchObject({
      code: "repurpose/nle_not_ready",
    });
  });

  it("is closed where clips are", async () => {
    const h = setup({ flow: false });
    const clipId = seedReady(h);
    await expect(
      h.service.createDownload(IDS.ws, IDS.viewer, IDS.run, clipId, "9:16"),
    ).rejects.toBeDefined();
    expect(h.redis.size).toBe(0);
  });
});

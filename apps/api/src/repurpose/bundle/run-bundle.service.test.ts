import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { RunBundleService, MAX_DOWNLOADS_PER_WORKSPACE } from "./run-bundle.service.js";
import {
  IDS,
  cleanCut,
  guestHarness,
  renderClip,
  seedClip,
  seedDub,
  storeEpisodePack,
  storeImages,
  type GuestHarness,
} from "../guest/guest-memory.test-support.js";

import type { RedisService } from "../../common/redis/redis.service.js";
import type { ObjectStore } from "../../common/storage/index.js";

const COPY = {
  summary: "The lights over the river",
  hook: "Wait for the lights",
  cta: "",
  hashtags: ["#diwali", "#varanasi"],
  locale: "en-IN",
  title: "Diwali on the ghats",
  description: "Every lamp on the river at once.",
};

const EPISODE = {
  chapters: [
    { startMs: 0, title: "Arriving" },
    { startMs: 754_000, title: "The aarti" },
  ],
  youtubeDescription: "A night on the ghats.",
  showNotes: "",
  linkedinPost: "What a festival teaches about attention.",
  xThread: ["One night.", "Ten thousand lamps."],
  newsletter: "",
  locale: "en-IN",
  source: "model",
};

interface Bundle {
  readonly harness: GuestHarness;
  readonly service: RunBundleService;
  /** Every object the fake store holds, by key. */
  readonly objects: Map<string, Buffer>;
  readonly redis: Map<string, string>;
}

function bundle(options: { readonly flow?: boolean } = {}): Bundle {
  const harness = guestHarness({
    ...(options.flow === false ? { flags: { repurpose_flow: false } } : {}),
  });
  const objects = new Map<string, Buffer>();
  const redis = new Map<string, string>();
  const store = {
    head: async (key: string) => {
      const data = objects.get(key);
      return data === undefined
        ? null
        : { sizeBytes: data.length, lastModified: new Date(2026, 9, 1, 9) };
    },
    openRead: async (key: string) => {
      const data = objects.get(key);
      if (data === undefined) throw new Error(`no object ${key}`);
      return {
        sizeBytes: data.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            // Two chunks, as a store sends a file in parts.
            controller.enqueue(new Uint8Array(data.subarray(0, Math.floor(data.length / 2))));
            controller.enqueue(new Uint8Array(data.subarray(Math.floor(data.length / 2))));
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
  const env = {
    API_ORIGIN: "https://api.aksharo.test",
    WEB_ORIGIN: "https://aksharo.test",
    FEATURE_FLAGS_JSON: {},
  } as unknown as Env;
  const service = new RunBundleService(
    harness.db.prisma,
    redisService,
    harness.reviews,
    harness.audit,
    store,
    env,
  );
  return { harness, service, objects, redis };
}

/** Stores a fake file under every key the seeded rows point at. */
function fill(b: Bundle): void {
  const keys = [
    ...b.harness.db.tables.export.map((row) => row["storageKey"]),
    ...b.harness.db.tables.mediaAsset.map((row) => row["storageKey"]),
    ...b.harness.db.tables.repurposeClip.flatMap((row) => {
      const images = row["images"] as { images?: { key: string }[] } | undefined;
      return (images?.images ?? []).map((image) => image.key);
    }),
  ];
  for (const key of keys) {
    if (typeof key === "string") b.objects.set(key, Buffer.from(`bytes of ${key}`));
  }
}

/** A clip in every shape, with clean cuts, images and words; one coming; one removed. */
function seedRun(b: Bundle): { readonly first: string; readonly second: string } {
  const db = b.harness.db;
  const first = seedClip(db, 1, { rendered: ["9:16", "4:5", "1:1", "16:9"], copy: COPY });
  for (const shape of ["9:16", "4:5", "1:1", "16:9"] as const) cleanCut(db, first, shape);
  storeImages(db, first, "9:16:EXP");
  // Only a clean 1:1 so far: it stands in for its missing captioned video.
  const second = seedClip(db, 2, { rendered: ["9:16"] });
  cleanCut(db, second, "1:1");
  seedDub(db, first, { languages: ["hi-IN"], shapes: ["9:16"] });
  seedClip(db, 3, { rendered: [] });
  seedClip(db, 4, { rendered: ["9:16"], removed: true });
  storeEpisodePack(db, EPISODE);
  return { first, second };
}

async function bytesOf(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

/** The archive's entries, from its central directory (a plain, non-ZIP64 archive). */
function entriesOf(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(start, start + size);
    expect(crc32(data) >>> 0).toBe(crc);
    out.set(name, data);
    at += 46 + nameLength + extraLength;
  }
  return out;
}

describe("RunBundleService", () => {
  it("sums up what the ZIP holds, with and without the clean cuts", async () => {
    const b = bundle();
    seedRun(b);
    fill(b);

    const summary = await b.service.summary(IDS.ws, IDS.run);

    expect(summary).toMatchObject({
      clips: 2,
      clipsComing: 1,
      // Clip 1 in four shapes, clip 2 in 9:16.
      videos: 5,
      dubbedVideos: 1,
      images: 4,
      // Clip 1's words and the episode text.
      texts: 2,
      // Clip 1's four clean cuts and the dub's: clip 2's clean 1:1 is in either way.
      cleanVideos: 5,
      filename: "Diwali vlog.zip",
    });
    expect(summary.bytesWithClean).toBeGreaterThan(summary.bytes);
  });

  it("streams the run as a ZIP from a single-use link", async () => {
    const b = bundle();
    seedRun(b);
    fill(b);

    const created = await b.service.createDownload(IDS.ws, IDS.viewer, IDS.run, {
      includeClean: false,
    });
    expect(created.url).toMatch(/^https:\/\/api\.aksharo\.test\/repurpose\/downloads\/[\w-]{43}$/);
    // Only the token's hash is kept.
    const token = created.url.split("/").at(-1) ?? "";
    expect([...b.redis.keys()].some((key) => key.includes(token))).toBe(false);

    const opened = await b.service.open(token);
    const zip = await bytesOf(opened.stream);
    expect(zip.length).toBe(opened.totalBytes);
    const entries = entriesOf(zip);
    const names = [...entries.keys()];

    const root = "Diwali vlog";
    expect(names).toContain(`${root}/Episode text.txt`);
    expect(names).toContain(`${root}/01 Clip 1/Clip 1 9x16.mp4`);
    expect(names).toContain(`${root}/01 Clip 1/Clip 1 16x9.mp4`);
    expect(names).toContain(`${root}/01 Clip 1/Words to post.txt`);
    expect(names).toContain(`${root}/01 Clip 1/Images/Clip 1 carousel-2.jpg`);
    expect(names).toContain(`${root}/01 Clip 1/Dubbed Hindi/Clip 1 9x16 Hindi.mp4`);
    expect(names).toContain(`${root}/02 Clip 2/Clip 2 9x16.mp4`);
    // A shape with only its clean cut has it, even unasked.
    expect(names).toContain(`${root}/02 Clip 2/Without captions/Clip 2 1x1 no captions.mp4`);
    // Not asked for: clip 1's clean cuts. Never: the removed clip, the one still coming.
    expect(names.some((name) => name.startsWith(`${root}/01 Clip 1/Without captions/`))).toBe(
      false,
    );
    expect(names.some((name) => name.includes("Clip 3") || name.includes("Clip 4"))).toBe(false);

    // The file is the stored object, byte for byte.
    const vertical = b.harness.db.tables.export.find(
      (row) => row["projectId"] === `PRJ-${"01JCLIP00000000000000000C1"}-r9x16`,
    );
    expect(entries.get(`${root}/01 Clip 1/Clip 1 9x16.mp4`)?.toString()).toBe(
      `bytes of ${String(vertical?.["storageKey"])}`,
    );
    const words = entries.get(`${root}/01 Clip 1/Words to post.txt`)?.toString() ?? "";
    expect(words).toContain("Diwali on the ghats");
    expect(words).toContain("#diwali #varanasi");
    const episode = entries.get(`${root}/Episode text.txt`)?.toString() ?? "";
    expect(episode).toContain("12:34 The aarti");
    expect(episode).toContain("2/2 Ten thousand lamps.");

    expect(b.harness.audits.at(-1)).toMatchObject({
      action: "repurpose.run.downloaded",
      resourceId: IDS.run,
      actorId: IDS.viewer,
      data: { files: names.length, includeClean: false },
    });

    // Spent: the same link does not work twice.
    await expect(b.service.open(token)).rejects.toMatchObject({
      code: "repurpose/download_expired",
    });
  });

  it("takes only the clips picked, without the video's own files, and says how many", async () => {
    const b = bundle();
    const { first, second } = seedRun(b);
    fill(b);

    const summary = await b.service.summary(IDS.ws, IDS.run, [second, "01JNOTOFTHISRUN0000000000"]);
    expect(summary).toMatchObject({
      clips: 1,
      clipsComing: 0,
      videos: 1,
      dubbedVideos: 0,
      // Clip 2 has no words to post, and the episode text is the video's, not a clip's.
      texts: 0,
      filename: "Diwali vlog (1 clip).zip",
    });

    const created = await b.service.createDownload(IDS.ws, IDS.viewer, IDS.run, {
      includeClean: false,
      clipIds: [first],
    });
    const opened = await b.service.open(created.url.split("/").at(-1) ?? "");
    expect(opened.filename).toBe("Diwali vlog (1 clip).zip");
    const names = [...entriesOf(await bytesOf(opened.stream)).keys()];
    expect(names).toContain("Diwali vlog/01 Clip 1/Clip 1 9x16.mp4");
    expect(names).toContain("Diwali vlog/01 Clip 1/Dubbed Hindi/Clip 1 9x16 Hindi.mp4");
    expect(names.some((name) => name.includes("Clip 2"))).toBe(false);
    expect(names).not.toContain("Diwali vlog/Episode text.txt");
    expect(b.harness.audits.at(-1)).toMatchObject({
      action: "repurpose.run.downloaded",
      data: { clips: 1 },
    });
  });

  it("says nothing is finished when no clip picked is", async () => {
    const b = bundle();
    seedRun(b);
    fill(b);
    const coming = String(
      b.harness.db.tables.repurposeClip.find((row) => row["title"] === "Clip 3")?.["id"],
    );
    await expect(
      b.service.createDownload(IDS.ws, IDS.viewer, IDS.run, {
        includeClean: false,
        clipIds: [coming],
      }),
    ).rejects.toMatchObject({ code: "repurpose/nothing_to_download" });
  });

  it("adds every clean cut when asked", async () => {
    const b = bundle();
    seedRun(b);
    fill(b);
    const created = await b.service.createDownload(IDS.ws, IDS.viewer, IDS.run, {
      includeClean: true,
    });
    const opened = await b.service.open(created.url.split("/").at(-1) ?? "");
    const names = [...entriesOf(await bytesOf(opened.stream)).keys()];
    expect(names).toContain("Diwali vlog/01 Clip 1/Without captions/Clip 1 4x5 no captions.mp4");
    expect(names).toContain(
      "Diwali vlog/01 Clip 1/Dubbed Hindi/Without captions/Clip 1 9x16 Hindi no captions.mp4",
    );
  });

  it("leaves out a file gone from the store", async () => {
    const b = bundle();
    const { second } = seedRun(b);
    fill(b);
    const gone = b.harness.db.tables.export.find(
      (row) => row["projectId"] === `PRJ-${second}-r9x16`,
    );
    b.objects.delete(String(gone?.["storageKey"]));
    const summary = await b.service.summary(IDS.ws, IDS.run);
    expect(summary.videos).toBe(4);
  });

  it("refuses an unknown or malformed link the same way", async () => {
    const b = bundle();
    for (const token of ["nope", "a".repeat(43)]) {
      await expect(b.service.open(token)).rejects.toMatchObject({
        code: "repurpose/download_expired",
        httpStatus: 404,
      });
    }
  });

  it("says when nothing is finished yet", async () => {
    const b = bundle();
    seedClip(b.harness.db, 1, { rendered: [] });
    await expect(
      b.service.createDownload(IDS.ws, IDS.viewer, IDS.run, { includeClean: false }),
    ).rejects.toMatchObject({ code: "repurpose/nothing_to_download", httpStatus: 409 });
  });

  it("is not there while the clips surface is off", async () => {
    const b = bundle({ flow: false });
    await expect(b.service.summary(IDS.ws, IDS.run)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("is not another workspace's run", async () => {
    const b = bundle();
    seedRun(b);
    await expect(b.service.summary(IDS.otherWs, IDS.run)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it("runs at most two downloads at once per workspace", async () => {
    const b = bundle();
    seedRun(b);
    fill(b);
    const start = async () => {
      const created = await b.service.createDownload(IDS.ws, IDS.viewer, IDS.run, {
        includeClean: false,
      });
      return b.service.open(created.url.split("/").at(-1) ?? "");
    };
    const running = await Promise.all(
      Array.from({ length: MAX_DOWNLOADS_PER_WORKSPACE }, async () => {
        const opened = await start();
        const reader = opened.stream[Symbol.asyncIterator]();
        await reader.next(); // started, not finished
        return reader;
      }),
    );
    await expect(start()).rejects.toMatchObject({
      code: "repurpose/downloads_busy",
      httpStatus: 429,
    });
    // One finishing frees a place.
    const first = running[0];
    if (first === undefined) throw new Error("no download");
    for (let step = await first.next(); step.done !== true; step = await first.next()) {
      // drain
    }
    await expect(start()).resolves.toMatchObject({ files: expect.any(Number) as number });
  });

  it("never reads a key outside the workspace", async () => {
    const b = bundle();
    const { first } = seedRun(b);
    fill(b);
    const clip = b.harness.db.tables.repurposeClip.find((row) => row["id"] === first);
    if (clip === undefined) throw new Error("no clip");
    clip["images"] = {
      fingerprint: "9:16:EXP",
      images: [
        {
          name: "thumbnail-1",
          key: `ws/${IDS.otherWs}/p/x/images/thumbnail-1.jpg`,
          width: 1,
          height: 1,
        },
      ],
    };
    b.objects.set(`ws/${IDS.otherWs}/p/x/images/thumbnail-1.jpg`, Buffer.from("theirs"));
    const summary = await b.service.summary(IDS.ws, IDS.run);
    expect(summary.images).toBe(0);
  });

  it("names a run's ZIP after its video, made safe for every desktop", async () => {
    const b = bundle();
    const run = b.harness.db.tables.repurposeRun.find((row) => row["id"] === IDS.run);
    if (run === undefined) throw new Error("no run");
    run["sourceTitle"] = 'Q&A: "Why?" | Part 1/2';
    seedClip(b.harness.db, 1, { rendered: ["9:16"] });
    renderClip(b.harness.db, "01JCLIP00000000000000000C1", "1:1");
    fill(b);
    const summary = await b.service.summary(IDS.ws, IDS.run);
    expect(summary.filename).toBe("Q&A Why Part 1 2.zip");
  });
});

/**
 * The B-roll library against a real PostgreSQL (2026-10-05): the migration's
 * table, its unique `(workspace, source, source_ref)` that keeps a stock photo
 * saved once - even when two saves race - while uploads (no `source_ref`) never
 * collide, and every read scoped to its own workspace.
 *
 * The object store and Pexels are in-memory fakes: nothing here reaches a
 * network, and nothing is ever written to a real bucket.
 */
import { type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { BrollLibraryService } from "../src/broll/broll.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { PexelsClient, PexelsPhoto } from "../src/broll/pexels.client.js";
import type { PrismaService } from "../src/common/prisma/prisma.service.js";
import type { ObjectStore } from "../src/common/storage/index.js";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[broll-library.e2e] SKIPPED - no test database. ${skipReason}`);
}

const WS = "01JBR0WS000000000000000001";
const OTHER_WS = "01JBR0WS000000000000000002";
const OWNER = "01JBR0USER0000000000000001";

/** A JPEG header claiming `width` x `height`: all the probe reads. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function memoryStore(objects: Map<string, Uint8Array>): ObjectStore {
  return {
    bucket: "memory",
    kind: "r2",
    createMultipartUpload: async () => {
      throw new Error("not used");
    },
    completeMultipartUpload: async () => ({}),
    abortMultipartUpload: async () => undefined,
    presignGet: async (key) => `https://memory.test/${key}`,
    presignPut: async (key) => `https://memory.test/${key}`,
    head: async (key) => {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { sizeBytes: bytes.byteLength };
    },
    put: async (input) => {
      objects.set(input.key, input.body as Uint8Array);
    },
    get: async (key) => Buffer.from(objects.get(key) ?? new Uint8Array()),
    delete: async (key) => {
      objects.delete(key);
    },
    deleteMany: async (keys) => {
      for (const key of keys) objects.delete(key);
      return keys.length;
    },
    tag: async () => undefined,
  } as ObjectStore;
}

const PHOTO: PexelsPhoto = {
  id: 1181,
  width: 3000,
  height: 4500,
  pageUrl: "https://www.pexels.com/photo/1181/",
  photographer: "Asha Rao",
  photographerUrl: "https://www.pexels.com/@asha-rao",
  alt: "The Taj Mahal at sunrise",
  originalUrl: "https://images.pexels.com/photos/1181/pexels-photo-1181.jpeg",
  previewUrl: "https://images.pexels.com/photos/1181/pexels-photo-1181.jpeg?h=350",
};

describe.skipIf(!available)("the B-roll library on PostgreSQL", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let library: BrollLibraryService;
  const objects = new Map<string, Uint8Array>();

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (created === null) throw new Error("expected a test database");
    db = created;
    prisma = db.prisma;
    await prisma.user.create({
      data: { id: OWNER, email: "broll-owner@example.test", name: "B-roll owner" },
    });
    for (const [id, slug] of [
      [WS, "broll-one"],
      [OTHER_WS, "broll-two"],
    ] as const) {
      await prisma.workspace.create({
        data: {
          id,
          slug,
          name: slug,
          ownerId: OWNER,
          billingCountry: "IN",
          billingStateCode: "27",
        },
      });
    }
    const pexels = {
      enabled: true,
      photo: async () => PHOTO,
      download: async () => jpeg(1707, 2560),
      search: async () => [PHOTO],
    } as unknown as PexelsClient;
    library = new BrollLibraryService(
      prisma as unknown as PrismaService,
      memoryStore(objects),
      pexels,
    );
  }, 60_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function upload(workspaceId: string, tags: string[]) {
    const ticket = await library.createUpload(workspaceId, {
      contentType: "image/jpeg",
      sizeBytes: 20,
    });
    objects.set(new URL(ticket.uploadUrl).pathname.slice(1), jpeg(1440, 2560));
    return library.complete(workspaceId, OWNER, ticket.assetId, {
      contentType: "image/jpeg",
      tags,
    });
  }

  it("keeps uploads side by side, tagged, each in its own workspace", async () => {
    const first = await upload(WS, ["Taj Mahal", "agra"]);
    const second = await upload(WS, []);
    const theirs = await upload(OTHER_WS, ["chai"]);
    expect(first.item.tags).toEqual(["taj mahal", "agra"]);
    expect(second.item.tags).toEqual([]);

    const mine = await library.list(WS);
    expect(mine.items.map((item) => item.assetId).sort()).toEqual(
      [first.item.assetId, second.item.assetId].sort(),
    );
    expect(await library.availableImages(WS, [first.item.assetId, theirs.item.assetId])).toEqual(
      new Set([first.item.assetId]),
    );
    expect(await library.remove(WS, theirs.item.assetId)).toBe(false);
    expect(await prisma.brollAsset.count({ where: { workspaceId: OTHER_WS } })).toBe(1);
  });

  it("saves a stock photo once, even when two saves race, with its credit", async () => {
    const [a, b] = await Promise.all([
      library.saveStock(WS, OWNER, { photoId: PHOTO.id, tags: ["taj mahal"] }),
      library.saveStock(WS, OWNER, { photoId: PHOTO.id, tags: ["taj mahal"] }),
    ]);
    expect(a.item.assetId).toBe(b.item.assetId);
    const rows = await prisma.brollAsset.findMany({
      where: { workspaceId: WS, source: "pexels", sourceRef: String(PHOTO.id) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credit).toEqual({
      provider: "pexels",
      photographer: "Asha Rao",
      photographerUrl: "https://www.pexels.com/@asha-rao",
      pageUrl: "https://www.pexels.com/photo/1181/",
    });
    // Only the kept copy's object is left: the loser's was deleted.
    const keys = [...objects.keys()].filter((key) => key.startsWith(`ws/${WS}/broll/`));
    expect(keys.filter((key) => key.endsWith(".jpg"))).toContain(rows[0]?.storageKey);
    // Another workspace saves its own copy of the same photo.
    await library.saveStock(OTHER_WS, OWNER, { photoId: PHOTO.id });
    expect(
      await prisma.brollAsset.count({ where: { source: "pexels", sourceRef: String(PHOTO.id) } }),
    ).toBe(2);
  });

  it("deletes a picture's object and its row", async () => {
    const { item } = await upload(WS, ["gateway of india"]);
    const row = await prisma.brollAsset.findUnique({ where: { id: item.assetId } });
    expect(objects.has(row?.storageKey ?? "")).toBe(true);
    expect(await library.remove(WS, item.assetId)).toBe(true);
    expect(await prisma.brollAsset.findUnique({ where: { id: item.assetId } })).toBeNull();
    expect(objects.has(row?.storageKey ?? "")).toBe(false);
  });
});

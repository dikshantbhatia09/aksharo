import { describe, expect, it, vi } from "vitest";

import {
  BROLL_ERROR_CODES,
  BROLL_MAX_ASSETS,
  BROLL_MAX_BYTES,
  BROLL_MAX_TAGS,
} from "./broll.constants.js";
import { BrollLibraryService } from "./broll.service.js";
import { type PexelsClient, PexelsError, type PexelsPhoto } from "./pexels.client.js";

const WS = "01JBRWS0000000000000000000";
const OTHER_WS = "01JBRWS0000000000000000001";
const USER = "01JBRUSER00000000000000000";

/** A real 8×4 PNG; {@link pngOfSize} rewrites its header (only the header is read). */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAEklEQVR4nGP4z8DwHx9moL0CAHD0P8F+ACg+AAAAAElFTkSuQmCC",
    "base64",
  ),
);
function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(PNG);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG header claiming `width` × `height` (a start-of-frame is all the probe reads). */
function jpegOfSize(width: number, height: number): Uint8Array {
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

interface Row {
  id: string;
  workspaceId: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
  tags: string[];
  title: string | null;
  source: string;
  sourceRef: string | null;
  credit: unknown;
  createdBy: string | null;
  createdAt: Date;
}

type Fake = ReturnType<typeof vi.fn>;

/** An in-memory `broll_assets` and object store: enough to run the service for real. */
function harness(
  options: {
    pexels?: { enabled?: boolean; search?: Fake; photo?: Fake; download?: Fake };
  } = {},
) {
  const rows = new Map<string, Row>();
  const objects = new Map<string, Uint8Array>();
  let clock = 0;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "id" && typeof value === "object" && value !== null && "in" in value) {
        return (value as { in: string[] }).in.includes(row.id);
      }
      // eslint-disable-next-line security/detect-object-injection -- a column name of this test's own where clause
      return (row as unknown as Record<string, unknown>)[key] === value;
    });
  const prisma = {
    brollAsset: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()]
          .filter((row) => matches(row, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          [...rows.values()].find((row) => matches(row, where)) ?? null,
      ),
      count: vi.fn(
        async ({ where }: { where: { workspaceId: string } }) =>
          [...rows.values()].filter((row) => row.workspaceId === where.workspaceId).length,
      ),
      create: vi.fn(async ({ data }: { data: Partial<Row> & { id: string } }) => {
        const clash = [...rows.values()].some(
          (row) =>
            data.sourceRef !== undefined &&
            data.sourceRef !== null &&
            row.workspaceId === data.workspaceId &&
            row.source === data.source &&
            row.sourceRef === data.sourceRef,
        );
        if (clash) throw Object.assign(new Error("unique"), { code: "P2002" });
        clock += 1;
        const defaults = {
          tags: [],
          title: null,
          source: "upload",
          sourceRef: null,
          credit: null,
          createdBy: null,
        };
        const row = {
          ...defaults,
          ...(data as Partial<Row>),
          createdAt: new Date(Date.UTC(2026, 9, 5, 0, 0, clock)),
        } as Row;
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id);
        if (row === undefined) throw new Error("no row");
        Object.assign(row, data);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const row of [...rows.values()]) {
          if (!matches(row, where)) continue;
          rows.delete(row.id);
          count += 1;
        }
        return { count };
      }),
    },
  };
  const store = {
    presignPut: vi.fn(async (key: string) => `https://put.example.test/${key}`),
    presignGet: vi.fn(async (key: string) => `https://get.example.test/${key}`),
    head: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { sizeBytes: bytes.byteLength };
    }),
    get: vi.fn(async (key: string) => Buffer.from(objects.get(key) ?? new Uint8Array())),
    put: vi.fn(async ({ key, body }: { key: string; body: Uint8Array }) => {
      objects.set(key, body);
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  const pexels: { enabled: boolean; search: Fake; photo: Fake; download: Fake } = {
    enabled: false,
    search: vi.fn(),
    photo: vi.fn(),
    download: vi.fn(),
    ...options.pexels,
  };
  const service = new BrollLibraryService(
    prisma as never,
    store as never,
    pexels as unknown as PexelsClient,
  );
  /** Uploads `bytes` the way the browser does: a ticket, a PUT, then complete. */
  async function upload(
    bytes: Uint8Array,
    contentType: "image/png" | "image/jpeg" | "image/webp" = "image/png",
    extra: { tags?: string[]; title?: string; workspaceId?: string } = {},
  ) {
    const workspaceId = extra.workspaceId ?? WS;
    const ticket = await service.createUpload(workspaceId, {
      contentType,
      sizeBytes: bytes.byteLength,
    });
    const key = new URL(ticket.uploadUrl).pathname.slice(1);
    objects.set(key, bytes);
    return service.complete(workspaceId, USER, ticket.assetId, {
      contentType,
      ...(extra.tags === undefined ? {} : { tags: extra.tags }),
      ...(extra.title === undefined ? {} : { title: extra.title }),
    });
  }
  return { service, prisma, store, rows, objects, pexels, upload };
}

describe("uploads", () => {
  it("keeps a picture under the workspace's own B-roll folder, measured and tagged", async () => {
    const h = harness();
    const { item, created } = await h.upload(pngOfSize(1440, 2560), "image/png", {
      tags: ["Taj Mahal", " taj-mahal ", "Agra"],
      title: "  trip photo  ",
    });
    expect(created).toBe(true);
    expect(item).toMatchObject({
      format: "png",
      contentType: "image/png",
      width: 1440,
      height: 2560,
      tags: ["taj mahal", "agra"],
      title: "trip photo",
      source: "upload",
      credit: null,
    });
    const row = h.rows.get(item.assetId);
    expect(row?.storageKey).toBe(`ws/${WS}/broll/${item.assetId}.png`);
    expect(item.url).toBe(`https://get.example.test/ws/${WS}/broll/${item.assetId}.png`);
    // Idempotent: the same upload completed again is the same picture.
    const again = await h.service.complete(WS, USER, item.assetId, { contentType: "image/png" });
    expect(again).toEqual({ item, created: false });
  });

  it("refuses bytes that are not what they claim, or an unusable size, and deletes them", async () => {
    const h = harness();
    await expect(h.upload(PNG, "image/jpeg")).rejects.toMatchObject({
      code: BROLL_ERROR_CODES.invalid,
    });
    await expect(h.upload(pngOfSize(200, 2560))).rejects.toMatchObject({
      code: BROLL_ERROR_CODES.badSize,
    });
    await expect(h.upload(pngOfSize(5000, 2560))).rejects.toMatchObject({
      code: BROLL_ERROR_CODES.badSize,
    });
    expect(h.objects.size).toBe(0);
    expect(h.rows.size).toBe(0);
  });

  it("refuses a file over the cap before any upload, and waits for the bytes on complete", async () => {
    const h = harness();
    await expect(
      h.service.createUpload(WS, { contentType: "image/png", sizeBytes: BROLL_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: BROLL_ERROR_CODES.tooLarge });
    const ticket = await h.service.createUpload(WS, { contentType: "image/png", sizeBytes: 10 });
    await expect(
      h.service.complete(WS, USER, ticket.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BROLL_ERROR_CODES.notUploaded });
  });

  it("keeps at most so many pictures, counted again on complete", async () => {
    const h = harness();
    for (let index = 0; index < BROLL_MAX_ASSETS - 1; index += 1) {
      h.rows.set(`R${String(index)}`, {
        id: `R${String(index)}`,
        workspaceId: WS,
        storageKey: "k",
        contentType: "image/png",
        sizeBytes: 1,
        width: 400,
        height: 400,
        tags: [],
        title: null,
        source: "upload",
        sourceRef: null,
        credit: null,
        createdBy: null,
        createdAt: new Date(0),
      });
    }
    // Two tickets with one place left: the second to complete is refused and its bytes deleted.
    const first = await h.service.createUpload(WS, { contentType: "image/png", sizeBytes: 9 });
    const second = await h.service.createUpload(WS, { contentType: "image/png", sizeBytes: 9 });
    for (const ticket of [first, second]) {
      h.objects.set(new URL(ticket.uploadUrl).pathname.slice(1), pngOfSize(800, 800));
    }
    await h.service.complete(WS, USER, first.assetId, { contentType: "image/png" });
    await expect(
      h.service.complete(WS, USER, second.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BROLL_ERROR_CODES.libraryFull });
    expect(h.objects.has(`ws/${WS}/broll/${second.assetId}.png`)).toBe(false);
    await expect(
      h.service.createUpload(WS, { contentType: "image/png", sizeBytes: 9 }),
    ).rejects.toMatchObject({ code: BROLL_ERROR_CODES.libraryFull });
  });
});

describe("another workspace's pictures", () => {
  it("are never found, changed, deleted, signed or offered", async () => {
    const h = harness();
    const { item } = await h.upload(pngOfSize(1440, 2560), "image/png", { tags: ["chai"] });
    await expect(
      h.service.complete(OTHER_WS, USER, item.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BROLL_ERROR_CODES.notFound });
    await expect(h.service.update(OTHER_WS, item.assetId, { tags: ["x"] })).rejects.toMatchObject({
      code: BROLL_ERROR_CODES.notFound,
    });
    expect(await h.service.remove(OTHER_WS, item.assetId)).toBe(false);
    expect(h.rows.has(item.assetId)).toBe(true);
    expect(await h.service.availableImages(OTHER_WS, [item.assetId])).toEqual(new Set());
    expect(await h.service.imageUrls(OTHER_WS, [item.assetId])).toEqual({});
    expect((await h.service.list(OTHER_WS)).items).toEqual([]);
    expect(await h.service.picturesFor(OTHER_WS)).toEqual([]);
    // Its own workspace sees it everywhere.
    expect(await h.service.availableImages(WS, [item.assetId, "../../x"])).toEqual(
      new Set([item.assetId]),
    );
    expect(await h.service.picturesFor(WS)).toEqual([
      {
        id: item.assetId,
        tags: ["chai"],
        title: null,
        width: 1440,
        height: 2560,
        format: "png",
      },
    ]);
  });
});

describe("tags and deleting", () => {
  it("changes a picture's tags, bounded, and deletes its object before its row", async () => {
    const h = harness();
    const { item } = await h.upload(pngOfSize(1440, 2560));
    const many = Array.from({ length: 15 }, (_, index) => `Tag ${String(index)}`);
    const updated = await h.service.update(WS, item.assetId, { tags: many, title: "" });
    expect(updated.tags).toHaveLength(BROLL_MAX_TAGS);
    expect(updated.title).toBeNull();

    expect(await h.service.remove(WS, item.assetId)).toBe(true);
    expect(h.store.delete).toHaveBeenCalledWith(`ws/${WS}/broll/${item.assetId}.png`);
    expect(h.rows.size).toBe(0);
    expect(await h.service.remove(WS, item.assetId)).toBe(false);
  });
});

describe("stock photos", () => {
  const photo: PexelsPhoto = {
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

  it("says stock is off, and refuses a search, without a key", async () => {
    const h = harness();
    expect((await h.service.list(WS)).stock).toEqual({ enabled: false, provider: null });
    h.pexels.search.mockRejectedValueOnce(new PexelsError("disabled", "off"));
    await expect(h.service.searchStock({ query: "chai", page: 1 })).rejects.toMatchObject({
      code: BROLL_ERROR_CODES.stockDisabled,
    });
  });

  it("saves a chosen photo with its credit, once, read from the service by its id", async () => {
    const h = harness({
      pexels: {
        enabled: true,
        photo: vi.fn(async () => photo),
        download: vi.fn(async () => jpegOfSize(1707, 2560)),
      },
    });
    expect((await h.service.list(WS)).stock).toEqual({ enabled: true, provider: "pexels" });
    const { item, created } = await h.service.saveStock(WS, USER, {
      photoId: 1181,
      tags: ["Taj Mahal"],
    });
    expect(created).toBe(true);
    expect(item).toMatchObject({
      format: "jpeg",
      width: 1707,
      height: 2560,
      tags: ["taj mahal"],
      title: "The Taj Mahal at sunrise",
      source: "pexels",
      credit: {
        provider: "pexels",
        photographer: "Asha Rao",
        photographerUrl: "https://www.pexels.com/@asha-rao",
        pageUrl: "https://www.pexels.com/photo/1181/",
      },
    });
    expect(h.pexels.download).toHaveBeenCalledWith(photo, 2560, BROLL_MAX_BYTES);
    expect(h.objects.has(`ws/${WS}/broll/${item.assetId}.jpg`)).toBe(true);

    // The same photo again: the picture already kept, with the new tag added.
    const again = await h.service.saveStock(WS, USER, { photoId: 1181, tags: ["agra"] });
    expect(again.created).toBe(false);
    expect(again.item.assetId).toBe(item.assetId);
    expect(again.item.tags).toEqual(["taj mahal", "agra"]);
    expect(h.pexels.photo).toHaveBeenCalledTimes(1);
  });

  it("refuses a photo the service sent too large a picture of, and keeps nothing", async () => {
    const h = harness({
      pexels: {
        enabled: true,
        photo: vi.fn(async () => photo),
        download: vi.fn(async () => jpegOfSize(6000, 9000)),
      },
    });
    await expect(h.service.saveStock(WS, USER, { photoId: 1181 })).rejects.toMatchObject({
      code: BROLL_ERROR_CODES.badSize,
    });
    expect(h.objects.size).toBe(0);
    expect(h.rows.size).toBe(0);
  });

  it("maps the service's refusals onto answers a person can act on", async () => {
    const cases = [
      [new PexelsError("busy", "x"), BROLL_ERROR_CODES.stockBusy, 429],
      [new PexelsError("unavailable", "x"), BROLL_ERROR_CODES.stockUnavailable, 502],
      [new PexelsError("not_found", "x"), BROLL_ERROR_CODES.stockNotFound, 404],
    ] as const;
    for (const [error, code, status] of cases) {
      const h = harness({
        pexels: { enabled: true, photo: vi.fn(async () => Promise.reject(error)) },
      });
      const refusal = await h.service.saveStock(WS, USER, { photoId: 1 }).catch((e: unknown) => e);
      expect(refusal).toMatchObject({ code });
      expect((refusal as { getStatus(): number }).getStatus()).toBe(status);
    }
  });

  it("gives Autopilot a stock photo tagged with the moment's phrase, or nothing, never an error", async () => {
    const search = vi.fn(async () => [photo]);
    const h = harness({
      pexels: {
        enabled: true,
        search,
        photo: vi.fn(async () => photo),
        download: vi.fn(async () => jpegOfSize(1707, 2560)),
      },
    });
    const picture = await h.service.stockForMoment(WS, "taj mahal", "portrait");
    expect(picture).toMatchObject({ tags: ["taj mahal"], width: 1707, height: 2560 });
    expect(search).toHaveBeenCalledWith(
      "taj mahal",
      { orientation: "portrait", perPage: 3 },
      "autopilot",
    );

    search.mockRejectedValueOnce(new PexelsError("busy", "spent"));
    expect(await h.service.stockForMoment(WS, "chai", "portrait")).toBeNull();
    search.mockResolvedValueOnce([]);
    expect(await h.service.stockForMoment(WS, "chai", "portrait")).toBeNull();
    const off = harness();
    expect(await off.service.stockForMoment(WS, "chai", "portrait")).toBeNull();
    expect(off.pexels.search).not.toHaveBeenCalled();
  });
});

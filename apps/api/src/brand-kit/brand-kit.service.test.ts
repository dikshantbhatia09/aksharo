import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BRAND_KIT_SETTINGS, type BrandKitSettings } from "@montaj/edg";

import {
  BRAND_KIT_ERROR_CODES,
  COVER_ERROR_CODES,
  COVER_MAX_BYTES,
  LOGO_MAX_BYTES,
  MUSIC_MAX_BYTES,
} from "./brand-kit.constants.js";
import { BRAND_FONT_FAMILIES, BrandKitService } from "./brand-kit.service.js";

const WS = "01JBKWS0000000000000000000";
const OTHER_WS = "01JBKWS0000000000000000001";
const USER = "01JBKUSER00000000000000000";

/** A real 8×4 PNG; {@link pngOfSize} rewrites its header for the sizes a logo can be. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAEklEQVR4nGP4z8DwHx9moL0CAHD0P8F+ACg+AAAAAElFTkSuQmCC",
    "base64",
  ),
);
/** The PNG with its header claiming `width` × `height` (only the header is read). */
function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(PNG);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

interface KitRow {
  id: string;
  workspaceId: string;
  name: string;
  doc: unknown;
  logoAssetId: string | null;
  musicAssetId?: string | null;
  isDefault: boolean;
  updatedAt: Date;
}

interface AssetRow {
  id: string;
  workspaceId: string;
  kind: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  createdBy: string | null;
  createdAt: Date;
  durationMs?: number | null;
  title?: string | null;
  rightsAttestedAt?: Date | null;
  rightsAttestedBy?: string | null;
}

/** An in-memory `brand_kits`, `brand_assets` and object store: enough to run the service for real. */
function harness(options: { drawn?: readonly string[] } = {}) {
  const kits = new Map<string, KitRow>();
  const assets = new Map<string, AssetRow>();
  const objects = new Map<string, Uint8Array>();
  const drawn = new Set(options.drawn ?? []);
  let clock = 0;
  const withLogo = (kit: KitRow | undefined) =>
    kit === undefined
      ? null
      : {
          ...kit,
          musicAssetId: kit.musicAssetId ?? null,
          logoAsset: kit.logoAssetId === null ? null : (assets.get(kit.logoAssetId) ?? null),
          musicAsset:
            kit.musicAssetId === null || kit.musicAssetId === undefined
              ? null
              : (assets.get(kit.musicAssetId) ?? null),
        };

  const prisma = {
    brandKit: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
        withLogo([...kits.values()].find((kit) => kit.workspaceId === where.workspaceId)),
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { workspaceId: string };
          create: Omit<KitRow, "updatedAt" | "logoAssetId"> & {
            logoAssetId?: string;
            musicAssetId?: string;
          };
          update: Partial<KitRow>;
        }) => {
          const existing = [...kits.values()].find((kit) => kit.workspaceId === where.workspaceId);
          clock += 1;
          if (existing === undefined) {
            const row: KitRow = {
              logoAssetId: null,
              ...create,
              updatedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, clock)),
            };
            kits.set(row.id, row);
            return row;
          }
          Object.assign(existing, update, {
            updatedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, clock)),
          });
          return existing;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<KitRow> }) => {
        const row = kits.get(where.id);
        if (row === undefined) throw new Error("no kit");
        Object.assign(row, data);
        return row;
      }),
    },
    brandAsset: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => assets.get(where.id) ?? null,
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { workspaceId: string; kind?: string; id?: { in: string[] } };
        }) =>
          [...assets.values()].filter(
            (asset) =>
              asset.workspaceId === where.workspaceId &&
              (where.kind === undefined || asset.kind === where.kind) &&
              (where.id === undefined || where.id.in.includes(asset.id)),
          ),
      ),
      create: vi.fn(async ({ data }: { data: Omit<AssetRow, "createdAt"> }) => {
        const row = { ...data, createdAt: new Date() };
        assets.set(row.id, row);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        assets.delete(where.id);
      }),
    },
    // `documentsDraw`: any document naming the id.
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const pattern = String(values[1] ?? "");
      const id = pattern.replace(/%/g, "");
      return drawn.has(id) ? [{ found: 1 }] : [];
    }),
  };
  const store = {
    presignPut: vi.fn(async (key: string) => `https://upload.example.test/${key}`),
    presignGet: vi.fn(async (key: string) => `https://cdn.example.test/${key}`),
    head: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes === undefined ? null : { sizeBytes: bytes.byteLength };
    }),
    get: vi.fn(async (key: string) => Buffer.from(objects.get(key) ?? new Uint8Array())),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  const service = new BrandKitService(prisma as never, store as never);
  /** What the browser does between the ticket and `complete`. */
  const put = (url: string, bytes: Uint8Array) => {
    objects.set(url.replace("https://upload.example.test/", ""), bytes);
  };
  return { service, prisma, store, kits, assets, objects, put, drawn };
}

const LOGO = pngOfSize(400, 200);

async function uploadLogo(
  h: ReturnType<typeof harness>,
  bytes: Uint8Array = LOGO,
  contentType: "image/png" | "image/jpeg" | "image/webp" = "image/png",
) {
  const ticket = await h.service.createLogoUpload(WS, { contentType, sizeBytes: bytes.byteLength });
  h.put(ticket.uploadUrl, bytes);
  return { ticket, done: await h.service.completeLogo(WS, USER, ticket.assetId, { contentType }) };
}

describe("BrandKitService.view", () => {
  it("answers the defaults with exists false for a workspace that never saved a kit", async () => {
    const h = harness();
    const view = await h.service.view(WS);
    expect(view).toMatchObject({
      exists: false,
      settings: DEFAULT_BRAND_KIT_SETTINGS,
      logo: null,
      images: {},
      updatedAt: null,
    });
    expect(view.fontFamilies).toEqual(BRAND_FONT_FAMILIES);
    expect(view.fontFamilies).toContain("Poppins");
    expect(view.limits.logoMaxBytes).toBe(LOGO_MAX_BYTES);
    expect(await h.service.forClips(WS)).toBeNull();
  });
});

describe("BrandKitService.update", () => {
  const settings: BrandKitSettings = {
    ...DEFAULT_BRAND_KIT_SETTINGS,
    captions: { fontFamily: "Poppins", highlight: "#f0508a" },
    endCard: { ...DEFAULT_BRAND_KIT_SETTINGS.endCard, enabled: true, cta: "Follow for more" },
  };

  it("creates the kit the first time and replaces it after, one per workspace", async () => {
    const h = harness();
    const first = await h.service.update(WS, settings);
    expect(first.exists).toBe(true);
    expect(first.settings).toEqual(settings);
    const second = await h.service.update(WS, { ...settings, captions: {} });
    expect(second.settings.captions).toEqual({});
    expect(h.kits.size).toBe(1);
    expect([...h.kits.values()][0]).toMatchObject({ workspaceId: WS, doc: { v: 1 } });
    expect(await h.service.forClips(WS)).toEqual({ settings: { ...settings, captions: {} } });
  });

  it("updates the kit a concurrent first write created, rather than failing", async () => {
    const h = harness();
    const real = h.prisma.brandKit.upsert.getMockImplementation();
    // The other writer's row lands between our read and our insert: the unique
    // workspace_id refuses ours, as Postgres would.
    h.prisma.brandKit.upsert.mockImplementationOnce(async (args) => {
      await real?.({ ...args, update: {} });
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });
    const view = await h.service.update(WS, settings);
    expect(view.settings).toEqual(settings);
    expect(h.kits.size).toBe(1);
  });

  it("refuses a typeface this product does not bundle", async () => {
    const h = harness();
    await expect(
      h.service.update(WS, { ...settings, hookTitle: { fontFamily: "Comic Sans MS" } }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.fontUnknown, httpStatus: 400 });
    expect(h.kits.size).toBe(0);
  });
});

describe("the logo", () => {
  it("signs a PUT under the workspace's brand prefix with the file's own extension", async () => {
    const h = harness();
    const ticket = await h.service.createLogoUpload(WS, {
      contentType: "image/webp",
      sizeBytes: 1_000,
    });
    expect(h.store.presignPut).toHaveBeenCalledWith(
      `ws/${WS}/brand/${ticket.assetId}.webp`,
      600,
      "image/webp",
    );
    expect(ticket.maxBytes).toBe(LOGO_MAX_BYTES);
    await expect(
      h.service.createLogoUpload(WS, { contentType: "image/png", sizeBytes: LOGO_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoTooLarge, httpStatus: 413 });
  });

  it("keeps a real image, records its size, and makes it the kit's (creating the kit)", async () => {
    const h = harness();
    const { ticket, done } = await uploadLogo(h);
    expect(done.replaced).toBeNull();
    expect(done.view.exists).toBe(true);
    expect(done.view.logo).toMatchObject({
      assetId: ticket.assetId,
      format: "png",
      contentType: "image/png",
      width: 400,
      height: 200,
    });
    expect(done.view.images).toEqual({
      [ticket.assetId]: `https://cdn.example.test/ws/${WS}/brand/${ticket.assetId}.png`,
    });
    expect(await h.service.forClips(WS)).toEqual({
      settings: DEFAULT_BRAND_KIT_SETTINGS,
      logo: { assetId: ticket.assetId, format: "png", width: 400, height: 200 },
    });
    // Completing the same upload again changes nothing.
    const again = await h.service.completeLogo(WS, USER, ticket.assetId, {
      contentType: "image/png",
    });
    expect(again.replaced).toBeNull();
    expect(h.assets.size).toBe(1);
  });

  it("refuses and deletes a file that is not what it claims, or an unusable size", async () => {
    const h = harness();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const lie = await h.service.createLogoUpload(WS, {
      contentType: "image/png",
      sizeBytes: svg.byteLength,
    });
    h.put(lie.uploadUrl, svg);
    await expect(
      h.service.completeLogo(WS, USER, lie.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoInvalid, httpStatus: 422 });

    // A real PNG declared as a JPEG is still not what it claims.
    const mislabelled = await h.service.createLogoUpload(WS, {
      contentType: "image/jpeg",
      sizeBytes: PNG.byteLength,
    });
    h.put(mislabelled.uploadUrl, PNG);
    await expect(
      h.service.completeLogo(WS, USER, mislabelled.assetId, { contentType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoInvalid });

    const tiny = await h.service.createLogoUpload(WS, { contentType: "image/png", sizeBytes: 100 });
    h.put(tiny.uploadUrl, PNG);
    await expect(
      h.service.completeLogo(WS, USER, tiny.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoBadSize });

    const huge = await h.service.createLogoUpload(WS, { contentType: "image/png", sizeBytes: 100 });
    h.put(huge.uploadUrl, pngOfSize(20_000, 20));
    await expect(
      h.service.completeLogo(WS, USER, huge.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoBadSize });

    // Past its declared size: the PUT is not held to it, the read-back is.
    const big = await h.service.createLogoUpload(WS, { contentType: "image/png", sizeBytes: 100 });
    h.put(big.uploadUrl, new Uint8Array(LOGO_MAX_BYTES + 1));
    await expect(
      h.service.completeLogo(WS, USER, big.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoTooLarge });

    expect(h.objects.size).toBe(0);
    expect(h.assets.size).toBe(0);
    expect(h.kits.size).toBe(0);
  });

  it("says so when the bytes have not arrived, and refuses another workspace's asset", async () => {
    const h = harness();
    const ticket = await h.service.createLogoUpload(WS, {
      contentType: "image/png",
      sizeBytes: 10,
    });
    await expect(
      h.service.completeLogo(WS, USER, ticket.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoNotUploaded, httpStatus: 409 });

    const { ticket: mine } = await uploadLogo(h);
    await expect(
      h.service.completeLogo(OTHER_WS, USER, mine.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoNotFound, httpStatus: 404 });
    await expect(
      h.service.completeLogo(WS, USER, "../../other", { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.logoNotFound });
  });

  it("deletes a replaced logo that nothing draws, and keeps one a clip still draws", async () => {
    const h = harness();
    const { ticket: first } = await uploadLogo(h);
    const { ticket: second, done } = await uploadLogo(h);
    expect(done.replaced).toBe(first.assetId);
    // Nothing drew the first: gone, object and row.
    expect(h.assets.has(first.assetId)).toBe(false);
    expect([...h.objects.keys()]).toEqual([`ws/${WS}/brand/${second.assetId}.png`]);

    // A clip carries the second; replacing it keeps it for that clip.
    h.drawn.add(second.assetId);
    const { ticket: third } = await uploadLogo(h);
    expect(h.assets.has(second.assetId)).toBe(true);
    const view = await h.service.view(WS);
    expect(view.logo?.assetId).toBe(third.assetId);
    expect(Object.keys(view.images).sort()).toEqual([second.assetId, third.assetId].sort());
    expect(await h.service.availableImages(WS, [second.assetId, first.assetId])).toEqual(
      new Set([second.assetId]),
    );
  });

  it("takes the logo off the kit, keeping it only while a clip draws it", async () => {
    const h = harness();
    const { ticket } = await uploadLogo(h);
    const removed = await h.service.removeLogo(WS);
    expect(removed.removed).toBe(ticket.assetId);
    expect(removed.view.logo).toBeNull();
    expect(h.assets.size).toBe(0);
    expect(await h.service.forClips(WS)).toEqual({ settings: DEFAULT_BRAND_KIT_SETTINGS });
    // Again: nothing to do.
    expect((await h.service.removeLogo(WS)).removed).toBeNull();
  });
});

describe("imageUrls", () => {
  it("signs only the workspace's own logos, and only real ids", async () => {
    const h = harness();
    const { ticket } = await uploadLogo(h);
    expect(
      await h.service.imageUrls(WS, [ticket.assetId, "../x", "01JN0SUCH00000000000000000"]),
    ).toEqual({
      [ticket.assetId]: `https://cdn.example.test/ws/${WS}/brand/${ticket.assetId}.png`,
    });
    expect(await h.service.imageUrls(OTHER_WS, [ticket.assetId])).toEqual({});
    expect(await h.service.imageUrls(WS, [])).toEqual({});
  });
});

describe("a run's cover (2026-10-04, audiograms)", () => {
  const COVER = pngOfSize(1_400, 1_400);

  async function uploadCover(
    h: ReturnType<typeof harness>,
    bytes: Uint8Array = COVER,
    workspaceId: string = WS,
  ) {
    const ticket = await h.service.createCoverUpload(workspaceId, {
      contentType: "image/png",
      sizeBytes: bytes.byteLength,
    });
    h.put(ticket.uploadUrl, bytes);
    return {
      ticket,
      view: await h.service.completeCover(workspaceId, USER, ticket.assetId, {
        contentType: "image/png",
      }),
    };
  }

  it("signs a PUT under the brand prefix, and takes a larger file than a logo", async () => {
    const h = harness();
    const ticket = await h.service.createCoverUpload(WS, {
      contentType: "image/jpeg",
      sizeBytes: LOGO_MAX_BYTES + 1,
    });
    expect(h.store.presignPut).toHaveBeenCalledWith(
      `ws/${WS}/brand/${ticket.assetId}.jpg`,
      600,
      "image/jpeg",
    );
    expect(ticket.maxBytes).toBe(COVER_MAX_BYTES);
    await expect(
      h.service.createCoverUpload(WS, { contentType: "image/png", sizeBytes: COVER_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: COVER_ERROR_CODES.tooLarge, httpStatus: 413 });
  });

  it("keeps a real image as a cover - not the kit's logo - and reads it back as artwork", async () => {
    const h = harness();
    const { ticket, view } = await uploadCover(h);
    expect(view).toMatchObject({
      assetId: ticket.assetId,
      format: "png",
      width: 1_400,
      height: 1_400,
      url: `https://cdn.example.test/ws/${WS}/brand/${ticket.assetId}.png`,
    });
    expect(h.assets.get(ticket.assetId)).toMatchObject({ kind: "cover", createdBy: USER });
    // Not a kit, and not a logo the kit would tidy away.
    expect(h.kits.size).toBe(0);
    expect(await h.service.collectUnusedLogos(WS)).toBe(0);
    expect(h.assets.has(ticket.assetId)).toBe(true);

    expect(await h.service.coverArtwork(WS, ticket.assetId)).toEqual({
      key: `ws/${WS}/brand/${ticket.assetId}.png`,
      format: "png",
    });
    expect(await h.service.coverExists(WS, ticket.assetId)).toBe(true);
    // Idempotent.
    const again = await h.service.completeCover(WS, USER, ticket.assetId, {
      contentType: "image/png",
    });
    expect(again.assetId).toBe(ticket.assetId);
    expect(h.assets.size).toBe(1);
  });

  it("is never another workspace's cover, nor a logo", async () => {
    const h = harness();
    const { ticket } = await uploadCover(h);
    expect(await h.service.coverArtwork(OTHER_WS, ticket.assetId)).toBeNull();
    expect(await h.service.coverExists(OTHER_WS, ticket.assetId)).toBe(false);
    await expect(
      h.service.completeCover(OTHER_WS, USER, ticket.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: COVER_ERROR_CODES.notFound, httpStatus: 404 });

    const { ticket: logo } = await uploadLogo(h);
    expect(await h.service.coverArtwork(WS, logo.assetId)).toBeNull();
    await expect(
      h.service.completeCover(WS, USER, logo.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: COVER_ERROR_CODES.notFound });
    expect(await h.service.coverArtwork(WS, "../../x")).toBeNull();
  });

  it("refuses and deletes what is not a usable image, with a cover's own codes", async () => {
    const h = harness();
    const notYet = await h.service.createCoverUpload(WS, {
      contentType: "image/png",
      sizeBytes: 10,
    });
    await expect(
      h.service.completeCover(WS, USER, notYet.assetId, { contentType: "image/png" }),
    ).rejects.toMatchObject({ code: COVER_ERROR_CODES.notUploaded, httpStatus: 409 });

    await expect(uploadCover(h, pngOfSize(32, 32))).rejects.toMatchObject({
      code: COVER_ERROR_CODES.badSize,
      httpStatus: 422,
    });
    await expect(uploadCover(h, new TextEncoder().encode("not an image"))).rejects.toMatchObject({
      code: COVER_ERROR_CODES.invalid,
      httpStatus: 422,
    });
    expect(h.objects.size).toBe(0);
    expect(h.assets.size).toBe(0);
  });

  it("names the kit's logo as the object it was uploaded to", () => {
    const h = harness();
    const assetId = "01JBK1060000000000000000A0";
    expect(h.service.logoArtwork(WS, { assetId, format: "jpeg", width: 10, height: 10 })).toEqual({
      key: `ws/${WS}/brand/${assetId}.jpg`,
      format: "jpeg",
    });
  });
});

/** A real mono 16-bit PCM WAV of silence, `seconds` long at 8 kHz. */
function wavOf(seconds: number): Uint8Array {
  const rate = 8_000;
  const data = Math.round(seconds * rate) * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(at + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  return bytes;
}

describe("the kit's music (2026-10-04)", () => {
  async function uploadMusic(
    h: ReturnType<typeof harness>,
    bytes: Uint8Array = wavOf(12),
    contentType: "audio/mpeg" | "audio/wav" | "audio/mp4" = "audio/wav",
  ) {
    const ticket = await h.service.createMusicUpload(WS, {
      contentType,
      sizeBytes: bytes.byteLength,
      rightsAttested: true,
    });
    h.put(ticket.uploadUrl, bytes);
    const done = await h.service.completeMusic(WS, USER, ticket.assetId, {
      contentType,
      rightsAttested: true,
      title: "  Morning theme ",
    });
    return { ticket, done };
  }

  it("signs a PUT for the track, only with the rights confirmed and under the size cap", async () => {
    const h = harness();
    const ticket = await h.service.createMusicUpload(WS, {
      contentType: "audio/mpeg",
      sizeBytes: 1_000,
      rightsAttested: true,
    });
    expect(h.store.presignPut).toHaveBeenCalledWith(
      `ws/${WS}/brand/${ticket.assetId}.mp3`,
      600,
      "audio/mpeg",
    );
    expect(ticket.maxBytes).toBe(MUSIC_MAX_BYTES);
    await expect(
      h.service.createMusicUpload(WS, {
        contentType: "audio/mpeg",
        sizeBytes: 1_000,
        rightsAttested: false,
      }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.musicRightsRequired, httpStatus: 400 });
    await expect(
      h.service.createMusicUpload(WS, {
        contentType: "audio/wav",
        sizeBytes: MUSIC_MAX_BYTES + 1,
        rightsAttested: true,
      }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.musicTooLarge, httpStatus: 413 });
  });

  it("keeps a real track with who confirmed the rights and when, and makes it the kit's", async () => {
    const h = harness();
    const before = Date.now();
    const { ticket, done } = await uploadMusic(h);
    expect(done.replaced).toBeNull();
    const row = h.assets.get(ticket.assetId);
    expect(row).toMatchObject({
      kind: "music",
      contentType: "audio/wav",
      durationMs: 12_000,
      title: "Morning theme",
      rightsAttestedBy: USER,
      createdBy: USER,
    });
    expect(row?.rightsAttestedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(done.view.exists).toBe(true);
    expect(done.view.music).toMatchObject({
      assetId: ticket.assetId,
      format: "wav",
      durationMs: 12_000,
      title: "Morning theme",
      rightsAttestedBy: USER,
      url: `https://cdn.example.test/ws/${WS}/brand/${ticket.assetId}.wav`,
    });
    const forClips = await h.service.forClips(WS);
    expect(forClips?.music).toEqual({
      assetId: ticket.assetId,
      rightsAttestedAt: row?.rightsAttestedAt?.toISOString(),
      rightsAttestedBy: USER,
      title: "Morning theme",
    });
    expect(forClips?.settings.music).toEqual({ enabled: true, level: "quiet" });
    expect(await h.service.musicStorageKeys(WS, [ticket.assetId, "../x"])).toEqual(
      new Map([[ticket.assetId, `ws/${WS}/brand/${ticket.assetId}.wav`]]),
    );
    expect(await h.service.musicStorageKeys(OTHER_WS, [ticket.assetId])).toEqual(new Map());
  });

  it("refuses without the rights confirmed, before anything is read", async () => {
    const h = harness();
    const ticket = await h.service.createMusicUpload(WS, {
      contentType: "audio/wav",
      sizeBytes: 100,
      rightsAttested: true,
    });
    h.put(ticket.uploadUrl, wavOf(12));
    await expect(
      h.service.completeMusic(WS, USER, ticket.assetId, {
        contentType: "audio/wav",
        rightsAttested: false,
      }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.musicRightsRequired });
    expect(h.store.get).not.toHaveBeenCalled();
    expect(h.assets.size).toBe(0);
  });

  it("refuses and deletes a track that is too short, too long, or not what it claims", async () => {
    const h = harness();
    await expect(uploadMusic(h, wavOf(2))).rejects.toMatchObject({
      code: BRAND_KIT_ERROR_CODES.musicBadLength,
      httpStatus: 422,
    });
    await expect(uploadMusic(h, wavOf(11 * 60))).rejects.toMatchObject({
      code: BRAND_KIT_ERROR_CODES.musicBadLength,
    });
    // A real WAV declared as an MP3 is still not what it claims.
    await expect(uploadMusic(h, wavOf(12), "audio/mpeg")).rejects.toMatchObject({
      code: BRAND_KIT_ERROR_CODES.musicInvalid,
    });
    await expect(uploadMusic(h, new TextEncoder().encode("not audio"))).rejects.toMatchObject({
      code: BRAND_KIT_ERROR_CODES.musicInvalid,
    });
    expect(h.objects.size).toBe(0);
    expect(h.assets.size).toBe(0);
    expect(h.kits.size).toBe(0);
  });

  it("says so before the bytes arrive, and refuses another workspace's track", async () => {
    const h = harness();
    const ticket = await h.service.createMusicUpload(WS, {
      contentType: "audio/wav",
      sizeBytes: 100,
      rightsAttested: true,
    });
    await expect(
      h.service.completeMusic(WS, USER, ticket.assetId, {
        contentType: "audio/wav",
        rightsAttested: true,
      }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.musicNotUploaded, httpStatus: 409 });
    const { ticket: mine } = await uploadMusic(h);
    await expect(
      h.service.completeMusic(OTHER_WS, USER, mine.assetId, {
        contentType: "audio/wav",
        rightsAttested: true,
      }),
    ).rejects.toMatchObject({ code: BRAND_KIT_ERROR_CODES.musicNotFound, httpStatus: 404 });
  });

  it("deletes a replaced track no clip plays, and keeps one a clip's bed still names", async () => {
    const h = harness();
    const { ticket: first } = await uploadMusic(h);
    const { ticket: second, done } = await uploadMusic(h);
    expect(done.replaced).toBe(first.assetId);
    expect(h.assets.has(first.assetId)).toBe(false);
    expect(h.objects.has(`ws/${WS}/brand/${first.assetId}.wav`)).toBe(false);

    h.drawn.add(second.assetId);
    await uploadMusic(h);
    expect(h.assets.has(second.assetId)).toBe(true);
  });

  it("takes the music off the kit, keeping it only while a clip plays it", async () => {
    const h = harness();
    const { ticket } = await uploadMusic(h);
    const removed = await h.service.removeMusic(WS);
    expect(removed.removed).toBe(ticket.assetId);
    expect(removed.view.music).toBeNull();
    expect(h.assets.size).toBe(0);
    expect((await h.service.forClips(WS))?.music).toBeUndefined();
    expect((await h.service.removeMusic(WS)).removed).toBeNull();
  });

  it("does not touch the logo, or the logo the music", async () => {
    const h = harness();
    const { ticket: logo } = await uploadLogo(h);
    const { ticket: music } = await uploadMusic(h);
    const view = await h.service.view(WS);
    expect(view.logo?.assetId).toBe(logo.assetId);
    expect(view.music?.assetId).toBe(music.assetId);
    await h.service.removeLogo(WS);
    expect((await h.service.view(WS)).music?.assetId).toBe(music.assetId);
  });
});

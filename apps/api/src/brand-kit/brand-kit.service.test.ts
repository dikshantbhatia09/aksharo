import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BRAND_KIT_SETTINGS, type BrandKitSettings } from "@montaj/edg";

import { BRAND_KIT_ERROR_CODES, LOGO_MAX_BYTES } from "./brand-kit.constants.js";
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
          logoAsset: kit.logoAssetId === null ? null : (assets.get(kit.logoAssetId) ?? null),
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
          create: Omit<KitRow, "updatedAt" | "logoAssetId"> & { logoAssetId?: string };
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

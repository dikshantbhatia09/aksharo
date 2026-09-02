import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fakeTtfBytes,
  sampleDevanagariFont,
  sampleLatinFont,
  withNoEmbedding,
} from "@montaj/fonts/testing";

import {
  customFontLimitFor,
  FONT_ATTESTATION,
  MAX_FONT_UPLOAD_BYTES,
  readFontMetrics,
} from "./fonts.constants.js";
import {
  fileNameOf,
  FontsService,
  sfntExtensionFor,
  stemOf,
  styleNameFor,
  toFontView,
} from "./fonts.service.js";
import { asMock } from "../../test/mock-args.js";

import type { PrismaService } from "../common/index.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { EntitlementService, EntitlementView } from "../workspaces/entitlement.service.js";
import type { Font } from "@prisma/client";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const OTHER_WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P9";
const FONT = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";
const USER = "01JBZ0Q4T7R8N4H1V0J9K2M3P8";

function entitlement(values: Record<string, unknown> = {}): EntitlementView {
  return {
    workspaceId: WORKSPACE,
    planKey: "creator",
    planName: "Creator",
    creditsPerMonthTenths: 3_000,
    seatsIncluded: 1,
    seatsUsed: 1,
    entitlements: { customFonts: 15, ...values },
    computedAt: new Date().toISOString(),
  };
}

function fontRow(overrides: Partial<Font> = {}): Font {
  return {
    id: FONT,
    workspaceId: WORKSPACE,
    family: "Bikaner",
    style: "regular",
    storageKey: `ws/${WORKSPACE}/fonts/${FONT}.ttf`,
    subsetKey: null,
    sizeBytes: BigInt(1_000),
    metrics: { status: "pending", sanitised: false, scripts: [], filename: "Bikaner.ttf" },
    licenceAttestedBy: null,
    attestedAt: null,
    licenceNote: null,
    servedOnlyToWorkspace: true,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  } as Font;
}

function fakeStore(): ObjectStore {
  return {
    bucket: "montaj-derived",
    kind: "r2",
    createMultipartUpload: vi.fn(),
    completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(),
    presignGet: vi.fn(async (key: string) => `https://store.test/${key}?sig=1`),
    presignPut: vi.fn(async (key: string) => `https://store.test/${key}?put=1`),
    head: vi.fn(async () => ({ sizeBytes: 4_096 })),
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => Buffer.from(sampleLatinFont())),
    delete: vi.fn(async () => undefined),
    deleteMany: vi.fn(async (keys: readonly string[]) => keys.length),
    tag: vi.fn(async () => undefined),
  } as unknown as ObjectStore;
}

function makeService(
  options: { row?: Partial<Font>; count?: number; plan?: Record<string, unknown> } = {},
) {
  const stored = fontRow(options.row ?? {});
  const prisma = {
    font: {
      create: vi.fn(async ({ data }: { data: Partial<Font> }) => fontRow(data)),
      update: vi.fn(async ({ data }: { data: Partial<Font> }) => fontRow({ ...stored, ...data })),
      delete: vi.fn(async () => stored),
      findFirst: vi.fn(async () => stored),
      findMany: vi.fn(async () => [stored]),
      count: vi.fn(async () => options.count ?? 0),
    },
  };
  const entitlements = {
    forWorkspace: vi.fn(async () => entitlement(options.plan ?? {})),
  };
  const store = fakeStore();
  const service = new FontsService(
    prisma as unknown as PrismaService,
    entitlements as unknown as EntitlementService,
    store,
  );
  return { service, prisma, store, entitlements, stored };
}

describe("initUpload", () => {
  it("signs a PUT at the CONTRACTS §6 key and returns the warranty text", async () => {
    const { service, store } = makeService();
    const ticket = await service.initUpload(WORKSPACE, {
      filename: "Bikaner.ttf",
      sizeBytes: 4_096,
      scripts: ["Deva"],
    });
    expect(ticket.key).toMatch(new RegExp(`^ws/${WORKSPACE}/fonts/[0-9A-HJKMNP-TV-Z]{26}\\.ttf$`));
    expect(ticket.url).toContain("put=1");
    expect(ticket.attestation).toEqual(FONT_ATTESTATION);
    expect(ticket.quota).toEqual({ used: 1, limit: 15, planKey: "creator" });
    expect(asMock(store.presignPut)).toHaveBeenCalled();
  });

  it("takes the container from the filename so an OTF keeps its own name", async () => {
    const { service } = makeService();
    const ticket = await service.initUpload(WORKSPACE, { filename: "X.otf", sizeBytes: 10 });
    expect(ticket.key.endsWith(".otf")).toBe(true);
  });

  it("refuses when the plan's custom-font allowance is used up", async () => {
    const { service } = makeService({ count: 15 });
    await expect(
      service.initUpload(WORKSPACE, { filename: "X.ttf", sizeBytes: 10 }),
    ).rejects.toMatchObject({ code: "fonts/plan_limit_reached" });
  });

  it("refuses every upload on a plan with no custom fonts", async () => {
    const { service } = makeService({ plan: { customFonts: 0 } });
    await expect(
      service.initUpload(WORKSPACE, { filename: "X.ttf", sizeBytes: 10 }),
    ).rejects.toMatchObject({ code: "fonts/plan_limit_reached" });
  });

  it("refuses a declared size past the cap before signing anything", async () => {
    const { service, store } = makeService();
    await expect(
      service.initUpload(WORKSPACE, {
        filename: "X.ttf",
        sizeBytes: MAX_FONT_UPLOAD_BYTES + 1,
      }),
    ).rejects.toMatchObject({ code: "fonts/too_large" });
    expect(asMock(store.presignPut)).not.toHaveBeenCalled();
  });

  it("records the declared scripts and filename on the pending row", async () => {
    const { service, prisma } = makeService();
    await service.initUpload(WORKSPACE, {
      filename: "Bikaner.ttf",
      sizeBytes: 4_096,
      scripts: ["Deva", "Latn"],
    });
    const data = asMock(prisma.font.create).mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const metrics = readFontMetrics(data.data["metrics"]);
    expect(metrics.scripts).toEqual(["Deva", "Latn"]);
    expect(metrics.filename).toBe("Bikaner.ttf");
    expect(data.data["servedOnlyToWorkspace"]).toBe(true);
  });
});

describe("complete", () => {
  const attest = { licenceAttested: true as const };

  it("refuses to process anything without the licence warranty", async () => {
    const { service, store } = makeService();
    await expect(
      service.complete(WORKSPACE, FONT, USER, { licenceAttested: false }),
    ).rejects.toMatchObject({ code: "fonts/attestation_required" });
    expect(asMock(store.get)).not.toHaveBeenCalled();
    expect(asMock(store.head)).not.toHaveBeenCalled();
  });

  it("refuses an attestation against an older text", async () => {
    const { service } = makeService();
    await expect(
      service.complete(WORKSPACE, FONT, USER, { ...attest, attestationVersion: "2020-01-01" }),
    ).rejects.toMatchObject({ code: "fonts/attestation_stale" });
  });

  it("records who attested, when, and against which text", async () => {
    const { service, prisma } = makeService();
    const view = await service.complete(WORKSPACE, FONT, USER, {
      ...attest,
      licenceNote: "Foundry order 4471",
    });
    const data = asMock(prisma.font.update).mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(data.data["licenceAttestedBy"]).toBe(USER);
    expect(data.data["attestedAt"]).toBeInstanceOf(Date);
    expect(data.data["licenceNote"]).toBe("Foundry order 4471");
    expect(readFontMetrics(data.data["metrics"]).attestationVersion).toBe(FONT_ATTESTATION.version);
    expect(view.sanitised).toBe(true);
    expect(view.status).toBe("ready");
  });

  it("writes the subset WOFF2 to the second CONTRACTS §6 slot", async () => {
    const { service, store } = makeService();
    await service.complete(WORKSPACE, FONT, USER, attest);
    const put = asMock(store.put).mock.calls[0]?.[0] as { key: string; body: Uint8Array };
    expect(put.key).toBe(`ws/${WORKSPACE}/fonts/${FONT}.woff2`);
    expect(String.fromCharCode(...put.body.subarray(0, 4))).toBe("wOF2");
    expect(asMock(store.tag)).toHaveBeenCalled();
  });

  it("takes the family name from the font, not from the uploader", async () => {
    const { service } = makeService();
    const view = await service.complete(WORKSPACE, FONT, USER, attest);
    expect(view.family).toBe("Noto Sans");
    expect(view.weight).toBe(400);
  });

  it("subsets to the declared scripts", async () => {
    const { service, store } = makeService({
      row: { metrics: { status: "pending", sanitised: false, scripts: ["Deva"] } },
    });
    asMock(store.get).mockResolvedValue(Buffer.from(sampleDevanagariFont()));
    const view = await service.complete(WORKSPACE, FONT, USER, attest);
    expect(view.scripts).toEqual(["Deva"]);
  });

  it("refuses a font whose declared script it does not cover, and deletes it", async () => {
    const { service, store, prisma } = makeService({
      row: { metrics: { status: "pending", sanitised: false, scripts: ["Taml"] } },
    });
    await expect(service.complete(WORKSPACE, FONT, USER, attest)).rejects.toMatchObject({
      code: "fonts/script_not_covered",
    });
    expect(asMock(store.deleteMany)).toHaveBeenCalled();
    expect(asMock(prisma.font.delete)).toHaveBeenCalled();
  });

  it("refuses a fake TTF and does not keep it in the bucket", async () => {
    const { service, store } = makeService();
    asMock(store.get).mockResolvedValue(Buffer.from(fakeTtfBytes()));
    await expect(service.complete(WORKSPACE, FONT, USER, attest)).rejects.toMatchObject({
      code: "fonts/unparsable",
    });
    expect(asMock(store.deleteMany)).toHaveBeenCalled();
  });

  it("refuses a font whose fsType forbids embedding", async () => {
    const { service, store } = makeService();
    asMock(store.get).mockResolvedValue(Buffer.from(withNoEmbedding(sampleLatinFont())));
    await expect(service.complete(WORKSPACE, FONT, USER, attest)).rejects.toMatchObject({
      code: "fonts/embedding_restricted",
    });
  });

  it("refuses an object the store says is too big, whatever was declared", async () => {
    const { service, store } = makeService();
    asMock(store.head).mockResolvedValue({ sizeBytes: MAX_FONT_UPLOAD_BYTES + 1 });
    await expect(service.complete(WORKSPACE, FONT, USER, attest)).rejects.toMatchObject({
      code: "fonts/too_large",
    });
    expect(asMock(store.get)).not.toHaveBeenCalled();
  });

  it("refuses when nothing was ever uploaded", async () => {
    const { service, store } = makeService();
    asMock(store.head).mockResolvedValue(null);
    await expect(service.complete(WORKSPACE, FONT, USER, attest)).rejects.toMatchObject({
      code: "fonts/upload_missing",
    });
  });

  it("is idempotent: a font already ready is returned untouched", async () => {
    const { service, store } = makeService({
      row: { metrics: { status: "ready", sanitised: true, scripts: ["Latn"] } },
    });
    const view = await service.complete(WORKSPACE, FONT, USER, attest);
    expect(view.status).toBe("ready");
    expect(asMock(store.get)).not.toHaveBeenCalled();
  });

  it("answers 404 for a font id from another workspace", async () => {
    const { service, prisma } = makeService();
    asMock(prisma.font.findFirst).mockResolvedValue(null);
    await expect(service.complete(OTHER_WORKSPACE, FONT, USER, attest)).rejects.toMatchObject({
      code: "fonts/not_found",
    });
  });
});

describe("serving", () => {
  const ready = {
    row: {
      subsetKey: `ws/${WORKSPACE}/fonts/${FONT}.woff2`,
      metrics: {
        status: "ready",
        sanitised: true,
        scripts: ["Deva"],
        wordScripts: ["devanagari"],
        weight: 700,
        italic: false,
        woff2SizeBytes: 900,
        sha256: "a".repeat(64),
      },
    } as Partial<Font>,
  };

  it("signs both objects for a ready font", async () => {
    const { service } = makeService(ready);
    const urls = await service.urls(WORKSPACE, FONT);
    expect(urls.url).toContain(`${FONT}.ttf`);
    expect(urls.woff2Url).toContain(`${FONT}.woff2`);
    expect(Date.parse(urls.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("refuses to sign a font that has not been sanitised", async () => {
    const { service } = makeService();
    await expect(service.urls(WORKSPACE, FONT)).rejects.toMatchObject({
      code: "fonts/invalid_state",
    });
  });

  it("builds a manifest a FontRegistry loader can read", async () => {
    const { service } = makeService(ready);
    const manifest = await service.manifest(WORKSPACE);
    expect(manifest.v).toBe(1);
    expect(manifest.origin).toBe("workspace");
    const face = manifest.fonts[0];
    expect(face?.id).toBe(FONT);
    expect(face?.file).toBe(`${FONT}.ttf`);
    expect(face?.woff2).toBe(`${FONT}.woff2`);
    expect(face?.weight).toBe(700);
    expect(face?.scripts).toEqual(["devanagari"]);
    expect(face?.url).toContain("sig=1");
    expect(face?.woff2Url).toContain("sig=1");
  });

  it("leaves an unsanitised font out of the manifest", async () => {
    const { service } = makeService();
    expect((await service.manifest(WORKSPACE)).fonts).toEqual([]);
  });

  it("lists every font, ready or not, so a picker can show progress", async () => {
    const { service } = makeService();
    const list = await service.list(WORKSPACE);
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("pending");
  });
});

describe("deleting", () => {
  it("removes both objects and the row", async () => {
    const { service, store, prisma } = makeService({
      row: { subsetKey: `ws/${WORKSPACE}/fonts/${FONT}.woff2` },
    });
    expect(await service.remove(WORKSPACE, FONT)).toEqual({ deleted: true });
    const keys = asMock(store.deleteMany).mock.calls[0]?.[0] as string[];
    expect(keys).toHaveLength(2);
    expect(asMock(prisma.font.delete)).toHaveBeenCalled();
  });

  it("purges every font object a workspace owns, for the erasure cascade", async () => {
    const { service, store } = makeService({
      row: { subsetKey: `ws/${WORKSPACE}/fonts/${FONT}.woff2` },
    });
    expect(await service.purgeWorkspace(WORKSPACE)).toEqual({ objects: 2 });
    expect(asMock(store.deleteMany)).toHaveBeenCalled();
  });

  it("purges nothing when the workspace has no fonts", async () => {
    const { service, prisma, store } = makeService();
    asMock(prisma.font.findMany).mockResolvedValue([]);
    expect(await service.purgeWorkspace(WORKSPACE)).toEqual({ objects: 0 });
    expect(asMock(store.deleteMany)).not.toHaveBeenCalled();
  });

  it("survives a store that refuses the delete", async () => {
    const { service, store } = makeService();
    asMock(store.deleteMany).mockRejectedValue(new Error("R2 is down"));
    await expect(service.remove(WORKSPACE, FONT)).resolves.toEqual({ deleted: true });
  });
});

describe("helpers", () => {
  it("names a style from its weight and slant", () => {
    expect(styleNameFor(400, false)).toBe("regular");
    expect(styleNameFor(700, false)).toBe("bold");
    expect(styleNameFor(600, false)).toBe("600");
    expect(styleNameFor(400, true)).toBe("italic");
    expect(styleNameFor(700, true)).toBe("bold italic");
  });

  it("takes the file name off a storage key", () => {
    expect(fileNameOf(`ws/${WORKSPACE}/fonts/${FONT}.woff2`)).toBe(`${FONT}.woff2`);
    expect(fileNameOf("bare.ttf")).toBe("bare.ttf");
  });

  it("guesses a family from a filename without trusting a path in it", () => {
    expect(stemOf("Bikaner-Bold.ttf")).toBe("Bikaner-Bold");
    expect(stemOf("../../etc/passwd")).toBe("passwd");
    expect(stemOf(".ttf")).toBe(".ttf");
    expect(stemOf("   ")).toBe("Custom font");
  });

  it("signs an upload as TTF unless the name says OTF", () => {
    expect(sfntExtensionFor("X.otf")).toBe("otf");
    expect(sfntExtensionFor("X.OTF")).toBe("otf");
    expect(sfntExtensionFor("X.ttf")).toBe("ttf");
    expect(sfntExtensionFor("X.woff2")).toBe("ttf");
    expect(sfntExtensionFor("X")).toBe("ttf");
  });

  it("reads the plan's allowance, falling back to zero rather than to unlimited", () => {
    expect(customFontLimitFor(entitlement())).toBe(15);
    expect(customFontLimitFor(entitlement({ customFonts: 50 }))).toBe(50);
    expect(customFontLimitFor(entitlement({ customFonts: "many" }))).toBe(0);
    expect(customFontLimitFor(entitlement({ customFonts: -1 }))).toBe(0);
    expect(customFontLimitFor(entitlement({ customFonts: undefined }))).toBe(0);
  });

  it("reads a metrics blob and survives a malformed one", () => {
    expect(readFontMetrics({ status: "ready", sanitised: true }).status).toBe("ready");
    expect(readFontMetrics(null).status).toBe("pending");
    expect(readFontMetrics({ status: "exploded" }).status).toBe("pending");
  });

  it("renders a row as the view the API returns", () => {
    const view = toFontView(
      fontRow({
        attestedAt: new Date("2026-09-02T10:00:00.000Z"),
        licenceAttestedBy: USER,
        sizeBytes: null,
      }),
    );
    expect(view.attestedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(view.licenceAttestedBy).toBe(USER);
    expect(view.sizeBytes).toBeNull();
  });
});

describe("the attestation record", () => {
  let current: string;
  beforeEach(() => {
    current = FONT_ATTESTATION.version;
  });

  it("is versioned and names the indemnity", () => {
    expect(current).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FONT_ATTESTATION.text).toMatch(/warrant/i);
    expect(FONT_ATTESTATION.text).toMatch(/indemnif/i);
    // CONTRACTS §0: the codename never appears in user-facing text.
    expect(FONT_ATTESTATION.text.toLowerCase()).not.toContain("montaj");
  });
});

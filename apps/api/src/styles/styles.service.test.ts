import { describe, expect, it, vi } from "vitest";

import type { StyleDoc } from "@montaj/caption-styles";

import { StylesService } from "./styles.service.js";
import { callArg } from "../../test/mock-args.js";

import type { PrismaService } from "../common/index.js";
import type { StylePreset } from "@prisma/client";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const SYSTEM_PRESET_ID = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const CUSTOM_PRESET_ID = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";

function styleDoc(overrides: Partial<StyleDoc> = {}): StyleDoc {
  return {
    id: "punch-pop",
    name: "Punch Pop",
    version: 2,
    category: "bold",
    minPlan: "free",
    typography: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePct: 8,
      lineHeightPct: 110,
      letterSpacingPct: 0,
      uppercase: false,
      maxCharsPerLine: 22,
      maxLines: 2,
    },
    colors: { fill: "#FFFFFF", highlight: "#FFD400", background: null },
    box: { enabled: false, paddingPct: 4, radiusPct: 3, colour: "#000000CC" },
    stroke: { enabled: true, widthPct: 6, colour: "#000000" },
    shadow: { enabled: true, offsetXPct: 0, offsetYPct: 4, blurPct: 12, colour: "#00000099" },
    layout: { anchor: "bottom-center", xPct: 50, yPct: 82, safeAreaPct: 6 },
    animation: { in: "pop", out: "fade", highlight: "scale", durationMs: 90 },
    emphasisPresets: [],
    assRenderable: false,
    assExportable: false,
    requiresLayoutMetrics: true,
    ...overrides,
  } as unknown as StyleDoc;
}

function presetRow(overrides: Partial<StylePreset> = {}): StylePreset {
  const doc = (overrides.doc as StyleDoc | undefined) ?? styleDoc();
  return {
    id: SYSTEM_PRESET_ID,
    workspaceId: null,
    key: "punch-pop",
    name: "Punch Pop",
    category: "bold",
    doc: doc as unknown as object,
    previewKey: "punch-pop.png",
    assRenderable: false,
    assExportable: false,
    requiresLayoutMetrics: true,
    parityScore: null,
    minPlan: "free",
    version: 1,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  } as unknown as StylePreset;
}

function makeService(rows: StylePreset[] = [presetRow()]) {
  const prisma = {
    stylePreset: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.find(
          (row) =>
            row.workspaceId === (where["workspaceId"] as string | null | undefined) &&
            row.key === where["key"],
        ) ??
        (typeof where["id"] === "string"
          ? (rows.find(
              (row) => row.id === where["id"] && row.workspaceId === where["workspaceId"],
            ) ?? null)
          : null),
      ),
      create: vi.fn(async ({ data }: { data: Partial<StylePreset> }) =>
        presetRow({ ...data, id: CUSTOM_PRESET_ID }),
      ),
      update: vi.fn(async ({ data }: { data: Partial<StylePreset> }) =>
        presetRow({ ...rows[0], ...data }),
      ),
      delete: vi.fn(async () => undefined),
    },
  };
  const service = new StylesService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe("StylesService.list", () => {
  it("returns system styles and this workspace's own, each shaped like a StyleDoc", async () => {
    const custom = presetRow({
      id: CUSTOM_PRESET_ID,
      workspaceId: WORKSPACE,
      key: "my-look",
      name: "My Look",
      doc: styleDoc({ id: "my-look", name: "My Look" }) as unknown as object,
      previewKey: null,
    });
    const { service } = makeService([presetRow(), custom]);
    const entries = await service.list(WORKSPACE);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "punch-pop", source: "system", workspaceId: null });
    expect(entries[1]).toMatchObject({ id: "my-look", source: "custom", workspaceId: WORKSPACE });
    // Every field `StylePicker` reads is present, unrenamed.
    expect(entries[0]?.["typography"]).toBeDefined();
    expect(entries[0]?.previewKey).toBe("punch-pop.png");
    expect(entries[1]?.previewKey).toBeNull();
  });
});

describe("StylesService.createPreset", () => {
  it("creates a preset keyed by doc.id", async () => {
    const { service, prisma } = makeService([presetRow()]);
    const doc = styleDoc({ id: "my-custom-look", name: "My Custom Look" });
    const entry = await service.createPreset(WORKSPACE, doc);

    expect(entry.source).toBe("custom");
    expect(entry.id).toBe("my-custom-look");
    const created = callArg(prisma.stylePreset.create, 0, 0) as { data: Partial<StylePreset> };
    expect(created.data.key).toBe("my-custom-look");
    expect(created.data.workspaceId).toBe(WORKSPACE);
  });

  it("refuses to shadow a system style's key (D64 / style/reserved_key)", async () => {
    const { service } = makeService([presetRow()]); // key "punch-pop", workspaceId null
    const doc = styleDoc({ id: "punch-pop" });
    await expect(service.createPreset(WORKSPACE, doc)).rejects.toMatchObject({
      code: "style/reserved_key",
    });
  });

  it("refuses a duplicate key within the same workspace (style/key_taken)", async () => {
    const existing = presetRow({ id: CUSTOM_PRESET_ID, workspaceId: WORKSPACE, key: "my-look" });
    const { service } = makeService([presetRow(), existing]);
    const doc = styleDoc({ id: "my-look" });
    await expect(service.createPreset(WORKSPACE, doc)).rejects.toMatchObject({
      code: "style/key_taken",
    });
  });
});

describe("StylesService.updatePreset", () => {
  it("updates the doc and bumps the version", async () => {
    const existing = presetRow({
      id: CUSTOM_PRESET_ID,
      workspaceId: WORKSPACE,
      key: "my-look",
      version: 1,
    });
    const { service, prisma } = makeService([existing]);
    const doc = styleDoc({ id: "my-look", name: "My Renamed Look" });
    await service.updatePreset(WORKSPACE, CUSTOM_PRESET_ID, doc);

    const updated = callArg(prisma.stylePreset.update, 0, 0) as { data: Partial<StylePreset> };
    expect(updated.data.name).toBe("My Renamed Look");
    expect(updated.data.version).toBe(2);
  });

  it("refuses to change the key (style/key_immutable)", async () => {
    const existing = presetRow({ id: CUSTOM_PRESET_ID, workspaceId: WORKSPACE, key: "my-look" });
    const { service } = makeService([existing]);
    const doc = styleDoc({ id: "a-different-key" });
    await expect(service.updatePreset(WORKSPACE, CUSTOM_PRESET_ID, doc)).rejects.toMatchObject({
      code: "style/key_immutable",
    });
  });

  it("answers style/not_found for another workspace's preset", async () => {
    const existing = presetRow({ id: CUSTOM_PRESET_ID, workspaceId: "01JOTHERWORKSPACE0000000A" });
    const { service } = makeService([existing]);
    await expect(
      service.updatePreset(WORKSPACE, CUSTOM_PRESET_ID, styleDoc()),
    ).rejects.toMatchObject({ code: "style/not_found" });
  });
});

describe("StylesService.deletePreset", () => {
  it("deletes an owned preset", async () => {
    const existing = presetRow({ id: CUSTOM_PRESET_ID, workspaceId: WORKSPACE });
    const { service, prisma } = makeService([existing]);
    const result = await service.deletePreset(WORKSPACE, CUSTOM_PRESET_ID);
    expect(result).toEqual({ id: CUSTOM_PRESET_ID });
    expect(prisma.stylePreset.delete).toHaveBeenCalledWith({ where: { id: CUSTOM_PRESET_ID } });
  });

  it("cannot delete a system style through the workspace route", async () => {
    const { service } = makeService([presetRow()]); // workspaceId: null
    await expect(service.deletePreset(WORKSPACE, SYSTEM_PRESET_ID)).rejects.toMatchObject({
      code: "style/not_found",
    });
  });
});

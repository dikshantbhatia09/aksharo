import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { isPickableStyle, type StyleDoc } from "@montaj/caption-styles";

import { STYLE_ERRORS } from "./styles.constants.js";
import { AppException, PrismaService } from "../common/index.js";

import type { $Enums, StylePreset } from "@prisma/client";

export interface StyleCatalogueEntry extends Omit<StyleDoc, "previewKey"> {
  readonly presetId: string;
  readonly source: "system" | "custom";
  readonly workspaceId: string | null;
  /** `null` when no static preview has been rendered for this style yet. */
  readonly previewKey: string | null;
}

/**
 * The style catalogue: the seeded system styles (`workspaceId = null`) plus one
 * workspace's own presets (07 §Styles, D64).
 *
 * `system-styles.ts` in the web app promises that "the shape a component
 * receives does not change" between the bundled dev fallback and this service —
 * every entry is a full `StyleDoc`, with `presetId`, `source` and `workspaceId`
 * added rather than anything renamed or removed.
 */
@Injectable()
export class StylesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The pickable system styles (`PICKABLE_STYLE_IDS`), then this workspace's
   * own. The other seeded system styles stay in the table — existing documents
   * still resolve them — but are no longer offered.
   */
  async list(workspaceId: string): Promise<StyleCatalogueEntry[]> {
    const rows = await this.prisma.stylePreset.findMany({
      where: { OR: [{ workspaceId: null }, { workspaceId }] },
      orderBy: [{ workspaceId: "asc" }, { key: "asc" }],
    });
    return rows.filter((row) => row.workspaceId !== null || isPickableStyle(row.key)).map(toEntry);
  }

  async createPreset(workspaceId: string, doc: StyleDoc): Promise<StyleCatalogueEntry> {
    await this.assertKeyAvailable(workspaceId, doc.id);

    const row = await this.prisma.stylePreset.create({
      data: {
        id: ulid(),
        workspaceId,
        key: doc.id,
        name: doc.name,
        category: doc.category,
        doc: doc as object,
        previewKey: doc.previewKey ?? null,
        minPlan: doc.minPlan as $Enums.PlanKey,
        version: 1,
      },
    });
    return toEntry(row);
  }

  async updatePreset(
    workspaceId: string,
    presetId: string,
    doc: StyleDoc,
  ): Promise<StyleCatalogueEntry> {
    const existing = await this.requireOwnPreset(workspaceId, presetId);
    if (existing.key !== doc.id) {
      throw new AppException(
        STYLE_ERRORS.keyImmutable,
        "A preset's id cannot change; create a new one instead.",
        HttpStatus.CONFLICT,
        { presetId, from: existing.key, to: doc.id },
      );
    }

    const row = await this.prisma.stylePreset.update({
      where: { id: presetId },
      data: {
        name: doc.name,
        category: doc.category,
        doc: doc as object,
        previewKey: doc.previewKey ?? null,
        minPlan: doc.minPlan as $Enums.PlanKey,
        version: existing.version + 1,
      },
    });
    return toEntry(row);
  }

  async deletePreset(workspaceId: string, presetId: string): Promise<{ id: string }> {
    await this.requireOwnPreset(workspaceId, presetId);
    await this.prisma.stylePreset.delete({ where: { id: presetId } });
    return { id: presetId };
  }

  /** @throws AppException 404 unless the preset exists and belongs to this workspace. */
  private async requireOwnPreset(workspaceId: string, presetId: string): Promise<StylePreset> {
    const preset = await this.prisma.stylePreset.findFirst({
      where: { id: presetId, workspaceId },
    });
    if (preset === null) {
      throw new AppException(STYLE_ERRORS.notFound, "No such style preset.", HttpStatus.NOT_FOUND, {
        presetId,
      });
    }
    return preset;
  }

  /**
   * A workspace may not shadow a system style's key, and may not create two
   * presets with the same key — both would make `styleRef` ambiguous.
   */
  private async assertKeyAvailable(workspaceId: string, key: string): Promise<void> {
    const system = await this.prisma.stylePreset.findFirst({
      where: { workspaceId: null, key },
      select: { id: true },
    });
    if (system !== null) {
      throw new AppException(
        STYLE_ERRORS.reservedKey,
        `"${key}" is a system style; choose a different id for a custom preset.`,
        HttpStatus.CONFLICT,
        { key },
      );
    }

    const own = await this.prisma.stylePreset.findFirst({
      where: { workspaceId, key },
      select: { id: true },
    });
    if (own !== null) {
      throw new AppException(
        STYLE_ERRORS.keyTaken,
        `This workspace already has a style preset "${key}".`,
        HttpStatus.CONFLICT,
        { key },
      );
    }
  }
}

function toEntry(row: StylePreset): StyleCatalogueEntry {
  const doc = row.doc as unknown as StyleDoc;
  return {
    ...doc,
    // The row is authoritative for identity and provenance even if a stale
    // `doc` blob ever disagreed with it.
    id: row.key,
    name: row.name,
    category: doc.category,
    presetId: row.id,
    source: row.workspaceId === null ? "system" : "custom",
    workspaceId: row.workspaceId,
    previewKey: row.previewKey,
  };
}

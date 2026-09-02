/**
 * Payload → the shapes `render-core` and `timemap` want.
 *
 * Three small adapters and one rule behind all of them: **the render draws the
 * snapshot the manifest was signed for**. The projection, the style documents
 * and the edit list all arrive inside the job, and nothing here reads the
 * project — a job that sat in a queue for ten minutes must still produce the
 * video the export dialog described, not whatever the document has become.
 */

import { StyleDocSchema, type StyleDoc } from "@montaj/caption-styles";
import type { EdgProjection } from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";
import { buildTimeMap, type Edit, type TimeMap } from "@montaj/timemap";

import type { RenderProjection } from "../queues.js";

export class ProjectionError extends Error {
  public override readonly name = "ProjectionError";
  constructor(
    readonly code: "render/bad-style" | "render/bad-projection",
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/**
 * The style catalogue for this render.
 *
 * The documents come from the payload rather than from
 * `@montaj/caption-styles`'s bundled catalogue so that a workspace preset or a
 * brand kit renders without this worker knowing anything about either — and so
 * a system style that changes next week does not change last week's export.
 * They are validated: an invalid StyleDoc reaching `layoutSegment` fails deep
 * inside layout with a message about a missing field.
 */
export function parseStyleCatalogue(
  styles: Readonly<Record<string, unknown>>,
): Map<string, StyleDoc> {
  const catalogue = new Map<string, StyleDoc>();
  for (const [id, document] of Object.entries(styles)) {
    const parsed = StyleDocSchema.safeParse(document);
    if (!parsed.success) {
      throw new ProjectionError(
        "render/bad-style",
        `style ${JSON.stringify(id)} is not a v2 StyleDoc`,
        {
          styleId: id,
          issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        },
      );
    }
    catalogue.set(id, parsed.data);
  }
  if (catalogue.size === 0) {
    throw new ProjectionError("render/bad-style", "the payload carries no style documents");
  }
  return catalogue;
}

/**
 * The payload projection plus the manifest's style and canvas decisions.
 *
 * `render.watermarkAssetId` is deliberately **not** set here. `renderFrame` would
 * happily draw it, but that would make the watermark a property of the
 * projection — which is the payload, which is not signed. The mark is added by
 * the frame source from `manifest.watermark` instead (THREAT-MODEL T10).
 */
export function toEdgProjection(
  projection: RenderProjection,
  manifest: RenderManifest,
): EdgProjection {
  if (projection.words.length === 0 && projection.segments.length > 0) {
    throw new ProjectionError(
      "render/bad-projection",
      "the projection has segments but no words to put in them",
    );
  }
  return {
    canvas: { width: manifest.output.width, height: manifest.output.height },
    styles: {
      defaultStyleId: manifest.styles.defaultStyleId,
      ...(manifest.styles.documentOverrides === undefined
        ? {}
        : { inline: { doc: manifest.styles.documentOverrides } }),
    },
    segments: projection.segments.map((segment) => ({
      id: segment.id,
      seq: segment.seq,
      startMs: segment.startMs,
      endMs: segment.endMs,
      startWordId: segment.startWordId,
      endWordId: segment.endWordId,
      ...(segment.styleRef === undefined ? {} : { styleRef: segment.styleRef }),
      ...(segment.overrides === undefined ? {} : { overrides: segment.overrides }),
      ...(segment.textOverrides === undefined ? {} : { textOverrides: segment.textOverrides }),
      ...(segment.emphasis === undefined ? {} : { emphasis: segment.emphasis }),
      ...(segment.hidden === undefined ? {} : { hidden: segment.hidden }),
      ...(segment.position === undefined ? {} : { position: segment.position }),
    })),
    words: projection.words.map((word) => ({
      wid: word.wid,
      s: word.s,
      e: word.e,
      t: word.t,
      ...(word.sp === undefined ? {} : { sp: word.sp }),
      ...(word.filler === undefined ? {} : { filler: word.filler }),
      ...(word.deleted === undefined ? {} : { deleted: word.deleted }),
      ...(word.scripts === undefined ? {} : { scripts: word.scripts }),
    })),
    ...(projection.speakerColours === undefined
      ? {}
      : { speakerColours: projection.speakerColours }),
  };
}

/**
 * The timemap for this render (D30).
 *
 * Always built, even with no edits: `outputDurationMs` is then just the source
 * length, and the frame loop, the caps check and the `-t` on the ffmpeg command
 * all read the same number from the same place.
 */
export function buildRenderTimeMap(manifest: RenderManifest): TimeMap {
  return buildTimeMap({
    sourceDurationMs: manifest.timemap.sourceDurationMs,
    edits: manifest.timemap.edits as readonly Edit[],
    ...(manifest.timemap.fps === undefined ? {} : { fps: manifest.timemap.fps }),
    snapCutsToFrames: manifest.timemap.snapCutsToFrames,
  });
}

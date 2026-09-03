/**
 * Turns the live EDG document into the two things a render job needs: the
 * `RenderProjection` (canvas, segments, words — the payload `apps/render`
 * validates against its own `RenderProjectionSchema`) and the style snapshot the
 * signed manifest pins (`@montaj/render-manifest` `StyleSnapshotSchema`).
 *
 * Both are read at request time and pinned into the job/manifest, never
 * re-fetched by the worker — a render must draw the document as it stood when
 * the manifest was signed, not whatever the project has become while the job
 * sat in a queue.
 */

import { createHash } from "node:crypto";

import type { EdgProjection, Speaker, TranscriptChunk } from "@montaj/edg/schemas";

import type { PrismaService } from "../common/prisma/prisma.service.js";

/** `apps/render/src/queues.ts` `RenderProjectionSchema`, restated for the API side. */
export interface RenderProjectionPayload {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly segments: readonly ProjectedSegment[];
  readonly words: readonly ProjectedWord[];
  readonly speakerColours?: Record<string, string>;
}

export interface ProjectedSegment {
  readonly id: string;
  readonly seq: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startWordId: string;
  readonly endWordId: string;
  readonly styleRef?: string;
  readonly overrides?: Record<string, unknown>;
  readonly textOverrides?: Record<string, string>;
  readonly emphasis?: readonly { readonly wordId: string; readonly presetId: string }[];
  readonly hidden?: boolean;
  readonly position?: { readonly x: number; readonly y: number; readonly anchor: string };
}

export interface ProjectedWord {
  readonly wid: string;
  readonly s: number;
  readonly e: number;
  readonly t: string;
  readonly sp?: string;
  readonly filler?: boolean;
  readonly deleted?: boolean;
  readonly scripts?: Record<string, string>;
}

/** Build the projection payload from the current EDG state and its transcript. */
export function buildRenderProjection(
  edg: EdgProjection,
  chunks: readonly TranscriptChunk[],
): RenderProjectionPayload {
  const segments: ProjectedSegment[] = edg.segments.map((segment) => ({
    id: segment.id,
    seq: segment.seq,
    startMs: segment.startMs,
    endMs: segment.endMs,
    startWordId: segment.startWordId,
    endWordId: segment.endWordId,
    ...(segment.styleRef === undefined ? {} : { styleRef: segment.styleRef }),
    ...(segment.overrides === undefined
      ? {}
      : { overrides: segment.overrides as Record<string, unknown> }),
    ...(segment.textOverrides === undefined ? {} : { textOverrides: segment.textOverrides }),
    ...(segment.emphasis === undefined ? {} : { emphasis: segment.emphasis }),
    ...(segment.hidden === undefined ? {} : { hidden: segment.hidden }),
    ...(segment.position === undefined ? {} : { position: segment.position }),
  }));

  const words: ProjectedWord[] = chunks.flatMap((chunk) =>
    chunk.words.map((word) => ({
      wid: word.wid,
      s: word.s,
      e: word.e,
      t: word.t,
      ...(word.sp === undefined ? {} : { sp: word.sp }),
      ...(word.filler === undefined ? {} : { filler: word.filler }),
      ...(word.deleted === undefined ? {} : { deleted: word.deleted }),
      ...(word.scripts === undefined ? {} : { scripts: word.scripts as Record<string, string> }),
    })),
  );

  const speakerColours = speakerColoursOf(edg.transcript.speakers);

  return {
    canvas: { width: edg.canvas.width, height: edg.canvas.height },
    segments,
    words,
    ...(speakerColours === undefined ? {} : { speakerColours }),
  };
}

function speakerColoursOf(
  speakers: readonly Speaker[] | undefined,
): Record<string, string> | undefined {
  if (speakers === undefined || speakers.length === 0) return undefined;
  const colours: Record<string, string> = {};
  for (const speaker of speakers) {
    if (speaker.color !== undefined) colours[speaker.id] = speaker.color;
  }
  return Object.keys(colours).length > 0 ? colours : undefined;
}

/** The manifest's style snapshot, plus the resolved `StyleDoc`s a render needs. */
export interface StyleSnapshotResolution {
  readonly defaultStyleId: string;
  readonly catalogueSnapshotIds: readonly string[];
  readonly documentOverrides?: Record<string, unknown>;
  /** `styleRef -> StyleDoc`, for every style a segment (or the default) references. */
  readonly styles: Record<string, unknown>;
}

/**
 * Resolve every style a document references (its default, plus each segment's
 * `styleRef`) against `style_presets` — a workspace row wins over the system row
 * of the same key, which is how a workspace overrides a system style without the
 * document itself changing. Content ids are `"<key>@<sha256 prefix>"`
 * (`packages/render-manifest` README), computed over the resolved `doc`.
 */
export async function resolveStyleSnapshot(
  prisma: PrismaService,
  workspaceId: string,
  edg: EdgProjection,
): Promise<StyleSnapshotResolution> {
  const defaultStyleId = edg.styles.defaultStyleId;
  const refs = new Set<string>([defaultStyleId]);
  for (const segment of edg.segments) {
    if (segment.styleRef !== undefined) refs.add(segment.styleRef);
  }

  const rows = await prisma.stylePreset.findMany({
    where: { key: { in: [...refs] }, OR: [{ workspaceId }, { workspaceId: null }] },
    select: { key: true, workspaceId: true, doc: true },
  });

  const byKey = new Map<string, { doc: unknown }>();
  for (const row of rows) {
    // A workspace row is visited after `null` is possible in either order from
    // Postgres, so an explicit preference keeps the workspace's own override
    // whichever way the rows came back.
    const existing = byKey.get(row.key);
    if (existing === undefined || row.workspaceId !== null) byKey.set(row.key, { doc: row.doc });
  }

  const styles: Record<string, unknown> = {};
  const catalogueSnapshotIds: string[] = [];
  for (const ref of refs) {
    const resolved = byKey.get(ref);
    // A style the document names but the catalogue no longer has (a deleted
    // custom preset) still needs a stable content id — hashing the bare ref
    // keeps the manifest well-formed rather than aborting the export over a
    // presentation detail.
    const doc = resolved?.doc ?? { styleRef: ref };
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    styles[ref] = doc;
    catalogueSnapshotIds.push(`${ref}@${contentHash(doc)}`);
  }

  const inline = edg.styles.inline as { doc?: Record<string, unknown> } | undefined;

  return {
    defaultStyleId,
    catalogueSnapshotIds,
    ...(inline?.doc === undefined ? {} : { documentOverrides: inline.doc }),
    styles,
  };
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 8);
}

import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { EdgProjection } from "@montaj/render-core";

import { MEDIA_ERRORS, PROJECT_ERRORS } from "./projects.constants.js";
import { AppException, PrismaService } from "../common/index.js";
import { DERIVED_STORE, DOWNLOAD_URL_TTL_SECONDS } from "../common/storage/index.js";
import { EdgRepository } from "../edg/index.js";
import { buildRenderProjection } from "../exports/projection.js";
import { FacesTrigger } from "../media/faces.js";

import type { ObjectStore } from "../common/index.js";

/**
 * What a read-only caption preview renders: the proxy, the face track that
 * keeps captions off faces, and the document as the exporter would draw it.
 */
export interface RenderPreview {
  readonly proxyUrl: string;
  /** `faces.json`, so the preview keeps captions off faces as the export does. */
  readonly facesUrl?: string;
  readonly durationMs: number | null;
  readonly aspect: string;
  /** Null until the project has an editing document. */
  readonly projection: EdgProjection | null;
}

/**
 * How long the workspace preview's URLs are signed for. The run page fetches
 * every clip's preview when it loads but plays one only when the person opens
 * it — minutes later, perhaps — and pins the first URL it gets for close to an
 * hour (`useStableUrl`, `useProjectRenderPreview`'s 45-minute `staleTime`), so
 * the public viewer's five minutes would 403 on the proxy and on `faces.json`
 * for any clip opened late. The same hour the run's mezzanine URLs get.
 */
export const WORKSPACE_PREVIEW_URL_TTL_SECONDS = 3_600;

/**
 * Build a project's preview, or `null` when it has no playable proxy yet.
 *
 * One definition for every surface that previews captions outside the editor —
 * the public share viewer (`ShareLinksService.preview`) and a run page's clip
 * preview (`GET /projects/{id}/render-preview`) — because both render through
 * the same `CaptionStage`, and two copies of this are how a preview starts to
 * disagree with the export it is meant to show. It reuses
 * `EdgRepository.projectionOf` unchanged, the same read `ExportsModule` makes to
 * render.
 *
 * Callers resolve and authorise the project first; this trusts the id it is given.
 *
 * @param options.ttlSeconds how long the URLs are signed for; the public
 *   viewer's `DOWNLOAD_URL_TTL_SECONDS` unless the caller says otherwise.
 * @param options.onMissingFaces told the media id when the video has a proxy but
 *   no face track, so a caller may queue detection for it.
 */
export async function buildRenderPreview(
  deps: {
    readonly prisma: PrismaService;
    readonly edg: EdgRepository;
    readonly derived: ObjectStore;
  },
  project: { readonly id: string; readonly aspect: string },
  options: {
    readonly ttlSeconds?: number;
    readonly onMissingFaces?: (mediaId: string) => void;
  } = {},
): Promise<RenderPreview | null> {
  const ttlSeconds = options.ttlSeconds ?? DOWNLOAD_URL_TTL_SECONDS;
  const media = await deps.prisma.mediaAsset.findFirst({
    where: { projectId: project.id, role: "primary", status: "ready" },
    orderBy: { createdAt: "desc" },
  });
  if (media === null || media.proxyKey === null || media.proxyKey === "") return null;

  const edgDocument = await deps.prisma.edgDocument.findUnique({
    where: { projectId: project.id },
    select: { id: true },
  });

  const proxyUrl = await deps.derived.presignGet(media.proxyKey, ttlSeconds);
  let projection: EdgProjection | null = null;
  if (edgDocument !== null) {
    const edg = await deps.edg.projectionOf(edgDocument.id);
    const chunks = await deps.edg.loadChunks(edg.transcript.transcriptId);
    const built = buildRenderProjection(edg, chunks);
    projection = {
      canvas: built.canvas,
      styles: edg.styles as EdgProjection["styles"],
      ...(edg.render === undefined ? {} : { render: edg.render as EdgProjection["render"] }),
      segments: built.segments,
      words: built.words,
      ...(built.speakerColours === undefined ? {} : { speakerColours: built.speakerColours }),
    };
  }

  if (media.facesKey === null) options.onMissingFaces?.(media.id);
  const facesUrl =
    media.facesKey === null ? undefined : await deps.derived.presignGet(media.facesKey, ttlSeconds);
  return {
    proxyUrl,
    ...(facesUrl === undefined ? {} : { facesUrl }),
    durationMs: media.durationMs,
    aspect: project.aspect,
    projection,
  };
}

/**
 * `GET /projects/{id}/render-preview` for a member of the project's workspace —
 * the share viewer's preview without a share link. The run page previews each
 * clip through it, so a person reviews the captions, style and face-aware
 * placement they will export rather than a browser's plain subtitle track.
 *
 * A video with a proxy and no face track has detection queued from here, once
 * (`onlyIfNeverTried`), the way `GET .../media/{id}/urls` does for the editor.
 * Clips cut before `ai.faces` existed have none, and the run page polls this
 * waiting for one: without the nudge only opening the editor would ever make it.
 */
@Injectable()
export class RenderPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly edg: EdgRepository,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    private readonly faces: FacesTrigger,
  ) {}

  /**
   * @throws AppException 404 for a missing, deleted or other tenant's project;
   *   409 while it has no playable proxy yet.
   */
  async forProject(workspaceId: string, projectId: string): Promise<RenderPreview> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true, aspect: true },
    });
    if (project === null) {
      throw new AppException(PROJECT_ERRORS.notFound, "No such project.", HttpStatus.NOT_FOUND, {
        projectId,
      });
    }

    const preview = await buildRenderPreview(
      { prisma: this.prisma, edg: this.edg, derived: this.derived },
      project,
      {
        ttlSeconds: WORKSPACE_PREVIEW_URL_TTL_SECONDS,
        // Not awaited: the preview does not wait on a job queue, and
        // `maybeEnqueue` never throws.
        onMissingFaces: (mediaId) => {
          void this.faces.maybeEnqueue(mediaId, { onlyIfNeverTried: true });
        },
      },
    );
    if (preview === null) {
      throw new AppException(
        MEDIA_ERRORS.invalidState,
        "This project has no playable preview yet.",
        HttpStatus.CONFLICT,
      );
    }
    return preview;
  }
}

import { HttpStatus, Inject, Injectable } from "@nestjs/common";

import type { EdgProjection } from "@montaj/render-core";

import { MEDIA_ERRORS, PROJECT_ERRORS } from "./projects.constants.js";
import { BrandKitService } from "../brand-kit/brand-kit.service.js";
import { BrollLibraryService } from "../broll/broll.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { DERIVED_STORE, DOWNLOAD_URL_TTL_SECONDS } from "../common/storage/index.js";
import { EdgRepository } from "../edg/index.js";
import {
  brollImageIds,
  buildRenderProjection,
  overlayImageIds,
  resolveStyleSnapshot,
} from "../exports/projection.js";
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
  /**
   * Signed URLs for the brand logos the projection's overlays draw, by asset id
   * (2026-10-02), and for its B-roll cutaways' pictures (2026-10-05):
   * `CaptionStage` fetches and registers them. Absent when it draws none.
   */
  readonly images?: Readonly<Record<string, string>>;
  /**
   * The workspace's own caption looks the projection references, as full
   * `StyleDoc`s keyed by the ref the document uses (2026-10-01). A browser
   * draws captions from its bundled system catalogue, which cannot know a look
   * a workspace saved itself ("My templates"), so without these the public
   * share viewer drew a clip made on a saved look in the default style while
   * the export drew it correctly. Only styles THIS document references, and
   * only those that resolved to the project's own workspace's preset row
   * (`resolveStyleSnapshot`, the same resolution an export makes): never
   * another workspace's, never the rest of the workspace's catalogue, and
   * nothing a system style already answers. Absent when there are none.
   */
  readonly styles?: Readonly<Record<string, unknown>>;
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
    /** Signs the brand logos a document draws; without it they are not signed. */
    readonly brandKits?: Pick<BrandKitService, "imageUrls">;
    /**
     * Signs the B-roll pictures a document's cutaways draw (2026-10-05);
     * without it no cutaway is previewed.
     */
    readonly broll?: Pick<BrollLibraryService, "imageUrls">;
  },
  project: { readonly id: string; readonly aspect: string; readonly workspaceId?: string },
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
  let images: Record<string, string> = {};
  let styles: Record<string, unknown> = {};
  if (edgDocument !== null) {
    const edg = await deps.edg.projectionOf(edgDocument.id);
    const chunks = await deps.edg.loadChunks(edg.transcript.transcriptId);
    // A brand kit's logo (2026-10-02): signed when the workspace still keeps
    // it, and left out of the projection when it does not, as in a render.
    const imageIds = overlayImageIds(edg);
    const signer = deps.brandKits;
    const canSign =
      imageIds.length > 0 && signer !== undefined && project.workspaceId !== undefined;
    if (canSign) images = await signer.imageUrls(project.workspaceId, imageIds, ttlSeconds);
    // B-roll pictures (2026-10-05): signed while the library keeps them; a
    // cutaway whose picture is gone, or that nothing here can sign, is left
    // out, as in a render.
    const brollIds = brollImageIds(edg);
    let brollImages: Record<string, string> = {};
    if (brollIds.length > 0 && deps.broll !== undefined && project.workspaceId !== undefined) {
      brollImages = await deps.broll.imageUrls(project.workspaceId, brollIds, ttlSeconds);
    }
    const built = buildRenderProjection(edg, chunks, {
      ...(canSign ? { images: new Set(Object.keys(images)) } : {}),
      ...(brollIds.length > 0 ? { brollImages: new Set(Object.keys(brollImages)) } : {}),
    });
    images = { ...images, ...brollImages };
    // The workspace's own looks (2026-10-01), resolved exactly as an export
    // resolves them and filtered to the project's own workspace's rows.
    if (project.workspaceId !== undefined) {
      styles = workspaceStylesOf(await resolveStyleSnapshot(deps.prisma, project.workspaceId, edg));
    }
    projection = {
      canvas: built.canvas,
      styles: edg.styles as EdgProjection["styles"],
      ...(edg.render === undefined ? {} : { render: edg.render as EdgProjection["render"] }),
      segments: built.segments,
      words: built.words,
      ...(built.speakerColours === undefined ? {} : { speakerColours: built.speakerColours }),
      // The hook title and the rest: the share viewer and a run's clip preview draw them too.
      ...(built.overlays === undefined ? {} : { overlays: built.overlays }),
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
    ...(Object.keys(images).length === 0 ? {} : { images }),
    ...(Object.keys(styles).length === 0 ? {} : { styles }),
  };
}

/**
 * The workspace-owned docs out of a style resolution, each stamped with the ref
 * the document uses as its `id` — the row's `key` is authoritative for identity
 * (`StylesService.toEntry` does the same), and the browser's catalogue is keyed
 * by it.
 */
function workspaceStylesOf(resolution: {
  readonly styles: Record<string, unknown>;
  readonly workspaceStyleIds: readonly string[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ref of resolution.workspaceStyleIds) {
    // eslint-disable-next-line security/detect-object-injection -- keys are the document's own style refs, read from our database
    const doc = resolution.styles[ref];
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) continue;
    // eslint-disable-next-line security/detect-object-injection -- as above
    out[ref] = { ...(doc as Record<string, unknown>), id: ref };
  }
  return out;
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
    private readonly brandKits: BrandKitService,
    private readonly broll: BrollLibraryService,
  ) {}

  /**
   * @throws AppException 404 for a missing, deleted or other tenant's project;
   *   409 while it has no playable proxy yet.
   */
  async forProject(workspaceId: string, projectId: string): Promise<RenderPreview> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true, aspect: true, workspaceId: true },
    });
    if (project === null) {
      throw new AppException(PROJECT_ERRORS.notFound, "No such project.", HttpStatus.NOT_FOUND, {
        projectId,
      });
    }

    const preview = await buildRenderPreview(
      {
        prisma: this.prisma,
        edg: this.edg,
        derived: this.derived,
        brandKits: this.brandKits,
        broll: this.broll,
      },
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

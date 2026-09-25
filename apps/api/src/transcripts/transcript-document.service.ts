import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import type { ScriptId } from "@montaj/edg/schemas";
import { segmentScript } from "@montaj/edg/segmenter";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { newestChunkRows } from "../edg/chunk-rows.js";
import { toChunk } from "../edg/edg.rows.js";
import { EdgService } from "../edg/index.js";
import { CAPTION_RENDER_CONTEXT, edgInitInputFor, resolveBudgets } from "../edg/init/index.js";

import type { CaptionRenderContext } from "../edg/init/index.js";

export type EnsureDocumentOutcome =
  | { readonly status: "exists"; readonly edgId: string }
  | { readonly status: "created"; readonly edgId: string; readonly segments: number }
  | { readonly status: "no_transcript" };

/**
 * Build a project's editing document from a transcript it **already has**.
 *
 * The invariant this exists to hold: *a project with a transcript has an editing
 * document.* Every producer used to be trusted to keep it by calling
 * `EdgService.initialise` itself — `ai.transcribe` does, `ai.align` does — and the
 * one that forgot (`media.clip`, which clones a slice of the source transcript
 * onto each clip's child project) left every clip unopenable: `/edg` answered
 * `edg/not_initialised`, `/transcription-state` answered `ready` because a
 * transcript existed, and the editor's waiting screen bounced between the two
 * several times a second, forever, on "Checking this project…".
 *
 * So the rule now has one owner that any path can call, idempotently:
 *
 * - `AutoTranscribeTrigger`, on `media.proxy` success, for a project whose
 *   transcript arrived before its media was ready (a clip) — the same moment an
 *   upload's first transcription is started, so the document is built against
 *   **probed** dimensions, which pick its canvas and caption budget.
 * - `TranscriptsService.transcriptionState`, as the repair of last resort: the
 *   read model never answers `ready` without a document behind it.
 *
 * Costs no credits: nothing is transcribed, the words are already stored.
 */
@Injectable()
export class TranscriptDocumentService {
  private readonly logger = new Logger(TranscriptDocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly edg: EdgService,
    /** The font stack the caption fit budget measures through (D78), as in `TranscribeCompletionHandler`. */
    @Optional()
    @Inject(CAPTION_RENDER_CONTEXT)
    private readonly render?: CaptionRenderContext,
  ) {}

  async ensure(projectId: string): Promise<EnsureDocumentOutcome> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        aspect: true,
        scripts: true,
        edgDocument: { select: { id: true } },
        mediaAssets: {
          where: { role: "primary" },
          select: { width: true, height: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    if (project === null) return { status: "no_transcript" };
    if (project.edgDocument !== null) return { status: "exists", edgId: project.edgDocument.id };

    const transcript = await this.prisma.transcript.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, language: true },
    });
    if (transcript === null) return { status: "no_transcript" };

    const chunks = (await newestChunkRows(this.prisma, transcript.id)).map(toChunk);
    const words = chunks.flatMap((chunk) => chunk.words);
    const budgets = resolveBudgets({
      script: segmentScript(words as unknown as Parameters<typeof segmentScript>[0]),
      ...(this.render === undefined ? {} : { render: this.render }),
      aspect: project.aspect,
      ...(project.mediaAssets[0] === undefined ? {} : { media: project.mediaAssets[0] }),
    });

    const initialised = await this.edg.initialise(
      projectId,
      edgInitInputFor({
        transcriptId: transcript.id,
        language: transcript.language,
        scripts: scriptsOf(project.scripts),
        chunks,
        budgets,
      }),
    );

    this.logger.log(
      { projectId, transcriptId: transcript.id, edgId: initialised.edgId, words: words.length },
      "built the editing document from the project's stored transcript",
    );
    return initialised.created
      ? { status: "created", edgId: initialised.edgId, segments: initialised.segments }
      : { status: "exists", edgId: initialised.edgId };
  }
}

/** `projects.scripts` (a `text[]`) as the script ids the document names. */
function scriptsOf(value: unknown): ScriptId[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ScriptId => typeof entry === "string");
}

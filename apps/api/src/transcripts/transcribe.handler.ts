import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { segmentScript } from "@montaj/edg/segmenter";

import { MemoryGlossarySource, postProcess } from "./postprocess/index.js";
import { quoteTranscription, settlementFor } from "./transcripts.quote.js";
import { TranscriptsRepository } from "./transcripts.repository.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgService } from "../edg/index.js";
import { CAPTION_RENDER_CONTEXT, edgInitInputFor, resolveBudgets } from "../edg/init/index.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { JobEventsService } from "../jobs/job-events.service.js";

import type { Correction, GlossaryTerm } from "./postprocess/index.js";
import type { IngestChunk, ProviderSubmissionInput } from "./transcripts.repository.js";
import type {
  CaptionBudgets,
  CaptionPreferences,
  CaptionRenderContext,
} from "../edg/init/index.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { RetentionClass } from "@prisma/client";

/**
 * What an `ai.transcribe` completion means (A11).
 *
 * The worker is **stateless**: it never writes a row. Its completion carries
 * `result.chunks` already shaped like `transcript_chunks` (A09's
 * `processors/transcribe.py::_result`), and everything that turns those chunks
 * into a project the user can edit happens here, in one place, in this order:
 *
 * ```
 * parse + validate result.chunks     (a worker is not trusted to be well-formed)
 * post-process                       (timings → integer ms, speakers, LID,
 *                                     punctuation, numerals, glossary, fillers)
 * persist                            (transcripts + transcript_chunks +
 *                                     provider_submissions, one transaction)
 * segment + initialise the EDG       (segmentWords → A12's EdgService.initialise)
 * record the corrections log         (a job event; the eval harness reads it)
 * → settlement figure back to A08, which settles and emits job.completed
 * ```
 *
 * ### Why the realtime event and the settlement are not in here
 *
 * They are A08's, and they are already exactly right: `JobsService.complete`
 * settles the hold behind the conditional `UPDATE` that makes settlement
 * exactly-once, and publishes `job.completed` afterwards. Duplicating either here
 * would mean two code paths for the one guarantee. What this handler contributes
 * is the **figure** (`actualTenths`) and the **facts** (`data`), and it runs
 * before both, so the event a client receives is only ever published once the
 * transcript is on disk.
 *
 * ### Idempotency
 *
 * Required, because the handler runs before the status flip and a callback is
 * at-least-once. Every write is an upsert or a replace keyed on ids the
 * *producer* minted (`transcriptId` in the job payload), and
 * `EdgService.initialise` is idempotent by project. Running this twice produces
 * the same rows; running it half-way and retrying converges.
 */

/**
 * Media time as it arrives from an ASR: a float, stored as an integer.
 *
 * The rounding happens **here**, at the trust boundary, and nowhere else. A
 * provider that reports 1.2345 s becomes 1234 ms before a single downstream
 * function sees it, so `Word.s`/`Word.e` are integers by construction (CONTRACTS
 * §2, A11 addendum) rather than by everyone remembering to round.
 */
const IngestMs = z
  .number()
  .min(0)
  .transform((value) => Math.round(value));

/** One word as the worker sends it — the frozen `Word` shape with float timings. */
const IngestWordSchema = z.object({
  // Parsed as a string and re-typed as the frozen template literal: Zod cannot
  // express `${number}:${number}`, and the regex is exactly that check.
  wid: z
    .string()
    .regex(/^\d+:\d+$/, "A word id is `<chunkIdx>:<n>` (CONTRACTS §2).")
    .transform((value) => value as `${number}:${number}`),
  s: IngestMs,
  e: IngestMs,
  t: z.string(),
  c: z.number().min(0).max(1).optional(),
  sp: z.string().min(1).optional(),
  scripts: z
    .object({
      roman: z.string().optional(),
      native: z.string().optional(),
      en: z.string().optional(),
    })
    .optional(),
  filler: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

/**
 * One chunk as the worker sends it.
 *
 * The `wid` check is the one invariant a malformed worker could otherwise smuggle
 * past every later layer: a word id carries its own chunk index, and an id that
 * disagrees with the row it is stored in makes the whole addressing scheme a lie
 * (06 invariant 4).
 */
const IngestChunkSchema = z
  .object({
    chunkIdx: z.number().int().min(0),
    startMs: IngestMs,
    endMs: IngestMs,
    /** The next free `n`; A12 allocates new word ids from it. */
    nextWordSeq: z.number().int().min(0).optional(),
    words: z.array(IngestWordSchema),
  })
  .check((ctx) => {
    const chunk = ctx.value;
    for (const [index, word] of chunk.words.entries()) {
      if (Number(word.wid.split(":")[0]) === chunk.chunkIdx) continue;
      ctx.issues.push({
        code: "custom",
        input: word.wid,
        path: ["words", index, "wid"],
        message: `word id ${word.wid} does not belong to chunk ${String(chunk.chunkIdx)}`,
      });
    }
  });

/** The worker's completion payload, as much of it as this handler relies on. */
const TranscribeResultSchema = z.object({
  /** Minted by the producer and echoed back; the row's identity. */
  transcriptId: z.string().min(1).optional(),
  mediaId: z.string().min(1).optional(),
  language: z.string().min(1).default("en"),
  languageConfidence: z.number().min(0).max(1).optional(),
  detectedLanguages: z
    .array(
      z.object({
        language: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.5),
        source: z.enum(["provider", "script"]).default("provider"),
      }),
    )
    .optional(),
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  alignerModel: z.string().min(1).max(128).optional(),
  diariser: z.string().min(1).max(128).optional(),
  lane: z.string().min(1).max(64).optional(),
  durationMs: z.number().int().min(0).optional(),
  chunks: z.array(IngestChunkSchema).min(1),
  providerSubmissions: z
    .array(
      z.object({
        provider: z.string().min(1).max(64),
        endpoint: z.string().max(512).optional(),
        artefact: z.string().max(256).optional(),
        externalRef: z.string().max(256).optional(),
        region: z.string().max(64).optional(),
        retentionClass: z.string().max(64).optional(),
      }),
    )
    .default([]),
});

export type TranscribeResult = z.infer<typeof TranscribeResultSchema>;

/** The producer's own payload, for the facts the worker does not echo back. */
const TranscribeParamsSchema = z.object({
  transcriptId: z.string().min(1).optional(),
  mediaId: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  hints: z.array(z.string().min(1)).default([]),
  revision: z.number().int().min(1).optional(),
  captions: z
    .object({
      maxLines: z.number().int().optional(),
      minMs: z.number().int().optional(),
      maxMs: z.number().int().optional(),
      maxChars: z.number().int().optional(),
      dropFillers: z.boolean().optional(),
      styleRef: z.string().min(1).max(64).optional(),
    })
    .optional(),
});

/** `provider_submissions.retention_class` is an enum; a vendor string is not. */
const RETENTION_CLASSES: Readonly<Record<string, RetentionClass>> = {
  zero: "zero_retention",
  zero_retention: "zero_retention",
  "zero-retention": "zero_retention",
  none: "zero_retention",
  short: "short_retention",
  short_retention: "short_retention",
  "short-retention": "short_retention",
  vendor_default: "vendor_default",
  default: "vendor_default",
};

/** Corrections carried on the job event; the rest are counted, not listed. */
export const MAX_LOGGED_CORRECTIONS = 500;

@Injectable()
export class TranscribeCompletionHandler implements JobCompletionHandler, OnModuleInit {
  readonly jobType: QueueName = "ai.transcribe";

  private readonly logger = new Logger(TranscribeCompletionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: TranscriptsRepository,
    private readonly edg: EdgService,
    private readonly glossary: MemoryGlossarySource,
    private readonly events: JobEventsService,
    private readonly registry: JobCompletionRegistry,
    /**
     * The font stack the caption fit budget measures through (D78). Optional:
     * A18b registers the production subset faces, and until it binds this the
     * budget is the `09 §3` readability cap alone.
     */
    @Optional()
    @Inject(CAPTION_RENDER_CONTEXT)
    private readonly render?: CaptionRenderContext,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome> {
    const { job } = context;
    const result = TranscribeResultSchema.parse(context.result);
    const params = TranscribeParamsSchema.parse(job.params ?? {});

    const projectId = job.projectId;
    if (projectId === null) {
      // A transcription with no project has nowhere to be written. Refusing is
      // better than inventing a home for it.
      throw new Error(`job ${job.id} is an ai.transcribe with no project`);
    }
    const transcriptId = result.transcriptId ?? params.transcriptId;
    if (transcriptId === undefined) {
      throw new Error(`job ${job.id} completed without a transcriptId to write to`);
    }

    // 1. Post-processing (`09 §3`). Pure, apart from the consent-gated glossary read.
    const hints: GlossaryTerm[] = params.hints.map((term) => ({ term, source: "glossary" }));
    const processed = await postProcess(result.chunks, {
      providerLanguage: result.language,
      ...(result.languageConfidence === undefined
        ? {}
        : { providerConfidence: result.languageConfidence }),
      ...(result.detectedLanguages === undefined
        ? {}
        : { providerLanguages: result.detectedLanguages }),
      ...(params.language === undefined ? {} : { hint: params.language }),
      workspaceId: job.workspaceId,
      glossarySource: this.glossary,
      extraTerms: hints,
    });

    // 2. One transaction: the transcript, its chunks and what left the building.
    const revision = params.revision ?? 1;
    const persisted = await this.repository.persist({
      transcriptId,
      projectId,
      workspaceId: job.workspaceId,
      jobId: job.id,
      mediaId: result.mediaId ?? params.mediaId ?? null,
      revision,
      language: processed.language,
      detectedLanguages: processed.detectedLanguages,
      provider: result.provider ?? context.usage?.provider ?? null,
      model: result.model ?? context.usage?.model ?? null,
      alignerModel: result.alignerModel ?? null,
      diariser: result.diariser ?? null,
      chunks: processed.chunks as unknown as readonly IngestChunk[],
      scripts: processed.scripts,
      submissions: submissionsFrom(result, context),
    });

    // 3. Segment the words and create the editing document (A12 owns the writes).
    //    The caption budget is `min(readability, fit)` for THIS project's canvas
    //    and style (D78) — see `edg/init/caption-budgets.ts`.
    const preferences: CaptionPreferences = params.captions ?? {};
    const budgets = await this.budgetsFor(projectId, processed.chunks, preferences);
    const initialised = await this.edg.initialise(
      projectId,
      edgInitInputFor({
        transcriptId,
        language: processed.language,
        scripts: processed.scripts,
        chunks: processed.chunks,
        speakers: processed.speakers,
        preferences,
        budgets,
      }),
    );

    // 4. The corrections log. `job_events` rather than a table of its own: it is
    //    an audit trail with the same lifetime as the job that produced it, and
    //    `GET /projects/{id}/transcript` reads it back for the review UI.
    await this.events.append({
      jobId: job.id,
      name: "transcript.postprocessed",
      message: `${String(processed.corrections.length)} corrections across ${String(
        persisted.chunks,
      )} chunks`,
      data: {
        transcriptId,
        revision,
        language: processed.language,
        detectedLanguages: processed.detectedLanguages,
        languageDisagreement: processed.languageDisagreement,
        steps: processed.steps,
        captionBudgets: budgets,
        correctionCount: processed.corrections.length,
        corrections: processed.corrections.slice(0, MAX_LOGGED_CORRECTIONS) as Correction[],
        truncated: processed.corrections.length > MAX_LOGGED_CORRECTIONS,
      },
    });

    const durationMs = result.durationMs ?? lastEndMs(processed.chunks);
    const quote = quoteTranscription(Math.max(durationMs, 1));
    const actualTenths = Math.min(
      job.creditsChargedTenths,
      settlementFor(quote, context.usage?.mediaSeconds),
    );

    this.logger.log(
      {
        jobId: job.id,
        projectId,
        transcriptId,
        chunks: persisted.chunks,
        words: persisted.words,
        segments: initialised.segments,
        edgCreated: initialised.created,
        language: processed.language,
      },
      "transcript persisted and the editing document initialised",
    );

    return {
      actualTenths,
      data: {
        transcriptId,
        revision,
        language: processed.language,
        chunks: persisted.chunks,
        words: persisted.words,
        segments: initialised.segments,
        edgId: initialised.edgId,
        edgRevision: initialised.revision,
        edgCreated: initialised.created,
        captionBudgets: budgets,
        providerSubmissions: persisted.submissions,
        corrections: processed.corrections.length,
      },
    };
  }

  /**
   * The caption budget for this project (decision D78).
   *
   * Two facts decide it and both live on rows this module does not own, so they
   * are read here rather than guessed: the project's **aspect** (which fixes the
   * canvas the fit cap is measured against) and the probed primary media's
   * **dimensions** (which say whether an untouched 9:16 default is really what
   * this footage is). The **script** comes from the transcript itself, because a
   * Devanagari transcript gets a 24-character line whatever the project settings
   * say.
   */
  private async budgetsFor(
    projectId: string,
    chunks: readonly { words: readonly { t: string }[] }[],
    preferences: CaptionPreferences,
  ): Promise<CaptionBudgets> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: {
        aspect: true,
        mediaAssets: {
          where: { role: "primary" },
          select: { width: true, height: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const script = segmentScript(
      chunks.flatMap((chunk) => chunk.words) as unknown as Parameters<typeof segmentScript>[0],
    );
    return resolveBudgets({
      script,
      ...(this.render === undefined ? {} : { render: this.render }),
      aspect: project?.aspect ?? null,
      ...(project?.mediaAssets[0] === undefined ? {} : { media: project.mediaAssets[0] }),
      ...(preferences.styleRef === undefined ? {} : { styleRef: preferences.styleRef }),
      preferences,
    });
  }
}

/**
 * `provider_submissions` rows for one completion.
 *
 * Every external call the worker recorded, plus — when it recorded none — a single
 * synthetic row from `usage.provider`. That fallback is the point of the table: an
 * erasure request (B16, THREAT-MODEL T24) has to be able to answer "who has a copy
 * of this audio?", and a provider adapter that forgot to call `context.record`
 * must not make the answer "nobody".
 */
export function submissionsFrom(
  result: TranscribeResult,
  context: JobCompletionContext,
): ProviderSubmissionInput[] {
  const rows: ProviderSubmissionInput[] = result.providerSubmissions.map((submission) => ({
    provider: submission.provider,
    endpoint: submission.endpoint ?? null,
    region: submission.region ?? null,
    externalRef: submission.externalRef ?? null,
    artefactKind: submission.artefact ?? "audio16k",
    retentionClass: retentionClassOf(submission.retentionClass),
  }));
  if (rows.length > 0) return rows;

  const provider = result.provider ?? context.usage?.provider;
  if (provider === undefined) return [];
  return [
    {
      provider,
      endpoint: null,
      region: null,
      externalRef: null,
      artefactKind: "audio16k",
      retentionClass: "vendor_default",
    },
  ];
}

/** An unknown retention string is `vendor_default`: never a promise we cannot keep. */
export function retentionClassOf(value: string | undefined): RetentionClass {
  if (value === undefined) return "vendor_default";
  return RETENTION_CLASSES[value.trim().toLowerCase()] ?? "vendor_default";
}

function lastEndMs(chunks: readonly { endMs: number }[]): number {
  return chunks.reduce((latest, chunk) => Math.max(latest, chunk.endMs), 0);
}

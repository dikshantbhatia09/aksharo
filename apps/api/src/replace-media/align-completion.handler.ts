/**
 * What a successful `ai.align` completion *means* (B15 brief §5, §6).
 *
 * There is exactly one handler per queue (`completion-handlers.ts`'s own
 * rule), so this one branches on `job.params.mode`:
 *
 *  - `"replace_media"` (brief §5): the document already exists — retime its
 *    live words in place (`SetWordTiming`) and widen the segments that moved
 *    (`SetSegmentBounds`), through the same op-batch write path a live editor
 *    uses, as `source: "worker"`. Text is never touched — the words being
 *    retimed are the *same* word ids the document already had.
 *  - `"import"` (brief §6): there is no document yet. The imported cues
 *    became the `segments[].text` the align request carried
 *    (`SubtitleImportService`); the answer becomes one transcript chunk
 *    (`TranscriptsRepository.persist`, same write A11 uses) and a fresh EDG
 *    document (`EdgService.initialise`), with the cues' own timing fed to the
 *    segmenter as `minMs`/`maxMs` hints so captions land close to the
 *    original cue boundaries rather than at A12's generic defaults — not
 *    identical to them, because the segmenter's public surface takes limits,
 *    not literal boundary positions.
 *
 * The worker's own contract (`apps/worker-ai/worker_ai/processors/align.py`)
 * answers one flat `words: [{s, e, t}]` array, in the same order the
 * request's `segments[].text` was given — both branches rebuild the mapping
 * back from that flat array using counts recorded in `job.params` at enqueue
 * time (`segmentWordIds` for replace-media, `cueWordCounts` for import).
 */

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import type { EdgOp } from "@montaj/edg/schemas";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgRepository } from "../edg/edg.repository.js";
import { EdgService } from "../edg/edg.service.js";
import { edgInitInputFor } from "../edg/init/index.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import { TranscriptsRepository } from "../transcripts/transcripts.repository.js";

import type { AlignSegmentWordIds } from "./align-payload.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";
import type { IngestChunk } from "../transcripts/transcripts.repository.js";

export interface AlignedWord {
  readonly s: number;
  readonly e: number;
  readonly t: string;
}

/** What `ReplaceMediaAlignTrigger` wrote into `job.params` at enqueue time. */
export interface ReplaceMediaAlignParams {
  readonly mode: "replace_media";
  readonly projectId: string;
  readonly segmentWordIds: readonly AlignSegmentWordIds[];
}

/** What `SubtitleImportService` writes into `job.params` at enqueue time. */
export interface ImportAlignParams {
  readonly mode: "import";
  readonly transcriptId: string;
  readonly mediaId: string | null;
  readonly language: string | null;
  /** Word count per cue, in the same order as the align request's `segments`. */
  readonly cueWordCounts: readonly number[];
  readonly segments: readonly { readonly startMs: number; readonly endMs: number }[];
}

export interface ReplaceMediaDiff {
  readonly segmentsConsidered: number;
  readonly wordsAligned: number;
  readonly wordsApplied: number;
  /** Rejected by the ops engine (`invalid-range`, `unknown-id`, ...) — the diff's "unmatched". */
  readonly wordsUnmatched: readonly { readonly wordId: string; readonly reason: string }[];
  readonly revision: number;
}

export interface ImportAlignOutcome {
  readonly transcriptId: string;
  readonly edgId: string;
  readonly revision: number;
  readonly segments: number;
  readonly words: number;
}

function isReplaceMediaParams(value: unknown): value is ReplaceMediaAlignParams {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["mode"] === "replace_media"
  );
}

function isImportParams(value: unknown): value is ImportAlignParams {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["mode"] === "import"
  );
}

@Injectable()
export class AlignCompletionHandler implements JobCompletionHandler, OnModuleInit {
  private readonly logger = new Logger(AlignCompletionHandler.name);

  readonly jobType: QueueName = "ai.align";

  constructor(
    private readonly edgRepository: EdgRepository,
    private readonly prisma: PrismaService,
    private readonly edgService: EdgService,
    private readonly transcripts: TranscriptsRepository,
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome | undefined> {
    const params: unknown = context.job.params;

    if (isImportParams(params)) {
      return this.handleImport(context, params);
    }
    if (isReplaceMediaParams(params)) {
      return this.handleReplaceMedia(context, params);
    }

    // Neither of this handler's recognised modes — nothing to do, and
    // nothing to fail: the worker's half is still done.
    this.logger.debug({ jobId: context.job.id }, "ai.align completion with no recognised mode");
    return undefined;
  }

  // -------------------------------------------------------------------------
  // §5: replace-media re-alignment
  // -------------------------------------------------------------------------

  private async handleReplaceMedia(
    context: JobCompletionContext,
    params: ReplaceMediaAlignParams,
  ): Promise<JobCompletionOutcome | undefined> {
    const words = parseAlignedWords(context.result);
    const flatWordIds = params.segmentWordIds.flatMap((segment) => segment.wordIds);

    if (words.length !== flatWordIds.length) {
      // The worker answered a different word count than it was asked to align —
      // a contract violation, not a normal "some words didn't match" outcome.
      throw new Error(
        `ai.align returned ${String(words.length)} words for ${String(flatWordIds.length)} requested`,
      );
    }

    const edgId = await this.projectEdgId(params.projectId);
    if (edgId === undefined) {
      this.logger.warn(
        { jobId: context.job.id },
        "replace-media align completed for a project with no EDG document",
      );
      return undefined;
    }
    const edg = await this.edgRepository.projectionOf(edgId);

    const ops: EdgOp[] = [];
    let cursor = 0;
    for (const segment of params.segmentWordIds) {
      const aligned = words.slice(cursor, cursor + segment.wordIds.length);
      cursor += segment.wordIds.length;
      if (aligned.length === 0) continue;

      const newStart = Math.min(...aligned.map((word) => word.s));
      const newEnd = Math.max(...aligned.map((word) => word.e));
      const existing = edg.segments.find((candidate) => candidate.id === segment.segmentId);
      if (existing === undefined) continue; // segment removed since enqueue — skip, don't fail the batch

      // Widen bounds first (SetWordTiming below is rejected if a word would
      // fall outside its segment's *current* bounds).
      ops.push({
        opId: ulid(),
        type: "SetSegmentBounds",
        segmentId: segment.segmentId,
        startMs: Math.min(newStart, existing.startMs),
        endMs: Math.max(newEnd, existing.endMs),
      });

      // The engine validates each `SetWordTiming` against its neighbours'
      // *current* (not final) timing, so applying left-to-right fails a
      // uniform delay (word 2 has not moved yet when word 1's new end would
      // overlap its still-old start) and applying right-to-left fails a
      // uniform advance, symmetrically. A re-recorded take shifts roughly
      // uniformly, so one pass in the direction the average shift moved
      // clears every word; anything genuinely non-monotonic still lands in
      // `wordsUnmatched` rather than being forced through.
      const indices = [...segment.wordIds.keys()];
      const shifts = indices
        .map((index) => {
          // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
          const word = aligned[index];
          return word === undefined ? undefined : word.s - existing.startMs;
        })
        .filter((value): value is number => value !== undefined);
      const meanShift =
        shifts.length === 0 ? 0 : shifts.reduce((sum, value) => sum + value, 0) / shifts.length;
      const order = meanShift < 0 ? indices : [...indices].reverse();

      for (const index of order) {
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        const wordId = segment.wordIds[index];
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        const word = aligned[index];
        if (wordId === undefined || word === undefined) continue;
        ops.push({ opId: ulid(), type: "SetWordTiming", wordId, s: word.s, e: word.e });
      }
    }

    const response = await this.edgService.applyWorkerOps({
      projectId: params.projectId,
      baseRevision: edg.meta.revision,
      ops,
      clientOpIds: ops.map((op) => op.opId),
    });

    const rejectedByWordId = new Map<string, string>();
    for (const rejection of response.rejected) {
      const op = ops.find((candidate) => candidate.opId === rejection.opId);
      if (op !== undefined && op.type === "SetWordTiming") {
        rejectedByWordId.set(op.wordId, rejection.reason);
      }
    }

    const diff: ReplaceMediaDiff = {
      segmentsConsidered: params.segmentWordIds.length,
      wordsAligned: words.length,
      wordsApplied: ops.filter((op) => op.type === "SetWordTiming").length - rejectedByWordId.size,
      wordsUnmatched: [...rejectedByWordId.entries()].map(([wordId, reason]) => ({
        wordId,
        reason,
      })),
      revision: response.revision,
    };

    this.logger.log(
      { jobId: context.job.id, projectId: params.projectId, diff },
      "replace-media re-alignment applied",
    );

    return { data: { diff } };
  }

  // -------------------------------------------------------------------------
  // §6: import transcript & align
  // -------------------------------------------------------------------------

  private async handleImport(
    context: JobCompletionContext,
    params: ImportAlignParams,
  ): Promise<JobCompletionOutcome | undefined> {
    const { job } = context;
    const projectId = job.projectId;
    if (projectId === null) {
      throw new Error(`job ${job.id} is an ai.align import with no project`);
    }

    const words = parseAlignedWords(context.result);
    const expectedWords = params.cueWordCounts.reduce((sum, count) => sum + count, 0);
    if (words.length !== expectedWords) {
      throw new Error(
        `ai.align returned ${String(words.length)} words for ${String(expectedWords)} cue words requested`,
      );
    }

    // One chunk, addressed `0:n` in reading order — every imported cue's words,
    // never rewritten past this point.
    let cursor = 0;
    let wordSeq = 0;
    const chunkWords: IngestChunk["words"] = [];
    const cueDurationsMs: number[] = [];
    for (const [cueIndex, count] of params.cueWordCounts.entries()) {
      const cueWords = words.slice(cursor, cursor + count);
      cursor += count;
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const cue = params.segments[cueIndex];
      if (cue !== undefined) cueDurationsMs.push(cue.endMs - cue.startMs);
      for (const word of cueWords) {
        chunkWords.push({
          wid: `0:${String(wordSeq)}` as `${number}:${number}`,
          s: word.s,
          e: word.e,
          t: word.t,
        });
        wordSeq += 1;
      }
    }

    const chunkEndMs = chunkWords.length === 0 ? 0 : Math.max(...chunkWords.map((word) => word.e));
    const chunk: IngestChunk = {
      chunkIdx: 0,
      startMs: 0,
      endMs: chunkEndMs,
      words: chunkWords,
      nextWordSeq: wordSeq,
    };

    const persisted = await this.transcripts.persist({
      transcriptId: params.transcriptId,
      projectId,
      workspaceId: job.workspaceId,
      jobId: job.id,
      mediaId: params.mediaId,
      revision: 1,
      language: params.language ?? "en",
      detectedLanguages: [],
      provider: "import",
      model: null,
      alignerModel: alignerModelFrom(context.result),
      diariser: null,
      chunks: [chunk],
      scripts: ["roman"],
      submissions: [],
    });

    // The cues' own median duration, fed to the segmenter as a *hint* — not a
    // literal boundary list (the segmenter's public surface takes limits, not
    // positions) — so captions land close to the imported cue rhythm instead
    // of A12's generic defaults.
    const medianCueMs = median(cueDurationsMs);
    const initialised = await this.edgService.initialise(
      projectId,
      edgInitInputFor({
        transcriptId: params.transcriptId,
        language: params.language ?? "en",
        scripts: ["roman"],
        chunks: [chunk],
        ...(medianCueMs === undefined
          ? {}
          : {
              preferences: {
                maxMs: Math.max(2_000, Math.round(medianCueMs * 1.5)),
                minMs: Math.min(500, Math.round(medianCueMs * 0.5)),
              },
            }),
      }),
    );

    const outcome: ImportAlignOutcome = {
      transcriptId: params.transcriptId,
      edgId: initialised.edgId,
      revision: initialised.revision,
      segments: initialised.segments,
      words: persisted.words,
    };

    this.logger.log(
      { jobId: context.job.id, projectId, outcome },
      "import-and-align created a new EDG document",
    );

    return { data: { outcome } };
  }

  private async projectEdgId(projectId: string): Promise<string | undefined> {
    const document = await this.prisma.edgDocument.findUnique({
      where: { projectId },
      select: { id: true },
    });
    return document?.id;
  }
}

function alignerModelFrom(result: Record<string, unknown>): string | null {
  const value = result["alignerModel"];
  return typeof value === "string" ? value : null;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[mid - 1];
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const right = sorted[mid];
  if (sorted.length % 2 === 0 && left !== undefined && right !== undefined) {
    return (left + right) / 2;
  }
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return sorted[mid];
}

function parseAlignedWords(result: Record<string, unknown>): readonly AlignedWord[] {
  const raw = result["words"];
  if (!Array.isArray(raw)) {
    throw new Error("ai.align result has no words[]");
  }
  return raw.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>)["s"] !== "number" ||
      typeof (entry as Record<string, unknown>)["e"] !== "number" ||
      typeof (entry as Record<string, unknown>)["t"] !== "string"
    ) {
      throw new Error(`ai.align result words[${String(index)}] is not {s, e, t}`);
    }
    const word = entry as Record<string, unknown>;
    return { s: word["s"] as number, e: word["e"] as number, t: word["t"] as string };
  });
}

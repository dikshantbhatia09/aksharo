/**
 * What a successful `ai.align` completion *means* (B15 brief §5, §6).
 *
 * There is exactly one handler per queue (`completion-handlers.ts`'s own
 * rule), so this one branches on `job.params.mode`:
 *
 *  - `"replace_media"` (this file, brief §5): the document already exists —
 *    retime its live words in place (`SetWordTiming`) and widen the segments
 *    that moved (`SetSegmentBounds`), through the same op-batch write path a
 *    live editor uses, as `source: "worker"`. Text is never touched — the
 *    words being retimed are the *same* word ids the document already had.
 *  - `"import"` (§6) is a separate work package increment and is not yet
 *    wired here; an `ai.align` job without a recognised `mode` is logged and
 *    left alone rather than guessed at.
 *
 * The worker's own contract (`apps/worker-ai/worker_ai/processors/align.py`)
 * answers one flat `words: [{s, e, t}]` array, in the same order the request's
 * `segments[].text` was given — this handler rebuilds the mapping back to word
 * ids from `job.params.segmentWordIds`, which `ReplaceMediaAlignTrigger` wrote
 * at enqueue time in that exact order.
 */

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import type { EdgOp } from "@montaj/edg/schemas";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgRepository } from "../edg/edg.repository.js";
import { EdgService } from "../edg/edg.service.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { AlignSegmentWordIds } from "./align-payload.js";
import type {
  JobCompletionContext,
  JobCompletionHandler,
  JobCompletionOutcome,
} from "../jobs/completion-handlers.js";
import type { QueueName } from "../jobs/contracts/queue-names.js";

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

export interface ReplaceMediaDiff {
  readonly segmentsConsidered: number;
  readonly wordsAligned: number;
  readonly wordsApplied: number;
  /** Rejected by the ops engine (`invalid-range`, `unknown-id`, ...) — the diff's "unmatched". */
  readonly wordsUnmatched: readonly { readonly wordId: string; readonly reason: string }[];
  readonly revision: number;
}

function isReplaceMediaParams(value: unknown): value is ReplaceMediaAlignParams {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["mode"] === "replace_media"
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
    private readonly registry: JobCompletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(context: JobCompletionContext): Promise<JobCompletionOutcome | undefined> {
    const params: unknown = context.job.params;
    if (!isReplaceMediaParams(params)) {
      // Not this handler's mode (or a future increment's, e.g. §6 import) —
      // nothing to do, and nothing to fail: the worker's half is still done.
      this.logger.debug({ jobId: context.job.id }, "ai.align completion with no recognised mode");
      return undefined;
    }

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
          const word = aligned[index];
          return word === undefined ? undefined : word.s - existing.startMs;
        })
        .filter((value): value is number => value !== undefined);
      const meanShift =
        shifts.length === 0 ? 0 : shifts.reduce((sum, value) => sum + value, 0) / shifts.length;
      const order = meanShift < 0 ? indices : [...indices].reverse();

      for (const index of order) {
        const wordId = segment.wordIds[index];
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

  private async projectEdgId(projectId: string): Promise<string | undefined> {
    const document = await this.prisma.edgDocument.findUnique({
      where: { projectId },
      select: { id: true },
    });
    return document?.id;
  }
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

import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { creditCostTenths, formatCredits } from "@montaj/config";
import type { Segment, TranscriptChunk } from "@montaj/edg/schemas";

import { MAX_TRANSLATE_TARGETS, SCRIPTS_ERROR_CODES } from "./scripts.errors.js";
import { ScriptsRepository, TranscriptNotFoundError } from "./scripts.repository.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { EdgService } from "../../edg/index.js";
import { JobEventsService } from "../../jobs/job-events.service.js";
import { JobsService } from "../../jobs/jobs.service.js";
import { resolveWorkspacePlan } from "../../jobs/plan.js";
import { MemoryGlossarySource } from "../postprocess/index.js";
import { segmentSourceTexts } from "../transcript-export.js";
import { TranscriptsRepository } from "../transcripts.repository.js";

import type { InternalScriptsWriteAck } from "./scripts.dto.js";
import type { ScriptWordInput } from "./scripts.repository.js";
import type { PlanKey, Transcript } from "@prisma/client";

/**
 * The scripts and translation producers, and the read that reports what a
 * transcript has available (A22).
 *
 * ### Why transliteration and translation are quoted so differently
 *
 * Transliteration is **free** — `09 §4` and `04-pricing-and-monetization.md`'s
 * burn-rate table has no row for it, because `packages/config/src/credits.ts`
 * (outside this work package's file boundary) is not the place to invent one.
 * The job is still admitted through `JobsService.enqueue` with a zero-tenths
 * hold, so CONTRACTS §4's "every producer reserves" rule holds even when the
 * reservation is for nothing.
 *
 * Translation reuses the **existing** `translation` burn rate (0.5 credit per
 * media minute per target language, English on Starter+, every language on
 * Creator+) and the existing plan gate this module implements against
 * `resolveWorkspacePlan` — free workspaces are refused outright, and a Starter
 * workspace asking for anything but English is refused too.
 */

export interface TransliterateInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly script: "roman" | "native";
}

export interface TransliterateAccepted {
  readonly jobId: string;
  readonly targetScript: "roman" | "native";
  readonly status: string;
  readonly deduplicated: boolean;
}

export interface TranslateInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly targets: readonly string[];
}

export interface TranslateTargetAccepted {
  readonly jobId: string;
  readonly targetLanguage: string;
  readonly status: string;
  readonly deduplicated: boolean;
  readonly quote: { readonly tenths: number; readonly credits: string };
}

export interface TranslateAccepted {
  readonly targets: readonly TranslateTargetAccepted[];
  readonly quote: { readonly tenths: number; readonly credits: string };
}

/**
 * Plan tiers, weakest first — for feature gating only.
 *
 * Deliberately **not** `PLAN_PRIORITY` from `jobs.config.ts`: that constant
 * ranks plans for BullMQ queue priority, where a *smaller* number runs first,
 * so `agency: 1 … free: 5` is "best plan gets the front of the queue," the
 * opposite direction a tier comparison like "is this workspace Starter or
 * above?" needs. Reusing it here for gating produced exactly the inverted
 * bug that reads like this: a Creator workspace (`PLAN_PRIORITY.creator === 3`)
 * failing `< PLAN_PRIORITY.starter` (`4`) as if it were *below* Starter.
 */
const PLAN_TIER: Readonly<Record<PlanKey, number>> = Object.freeze({
  free: 0,
  starter: 1,
  creator: 2,
  studio: 3,
  agency: 4,
});

export interface ScriptAvailability {
  readonly script: "roman" | "native" | "en" | "translated";
  readonly available: boolean;
  readonly source?: "transcription" | "transliteration" | "translation";
  readonly provider?: string | null;
  readonly language?: string;
  readonly updatedAt?: string;
}

@Injectable()
export class ScriptsService {
  private readonly logger = new Logger(ScriptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: TranscriptsRepository,
    private readonly scriptsRepository: ScriptsRepository,
    private readonly jobs: JobsService,
    private readonly edg: EdgService,
    private readonly glossary: MemoryGlossarySource,
    private readonly events: JobEventsService,
  ) {}

  // -------------------------------------------------------------------------
  // Producing
  // -------------------------------------------------------------------------

  /** `POST /projects/{id}/transcript/transliterate` — free, `ai.transliterate`. */
  async transliterate(input: TransliterateInput): Promise<TransliterateAccepted> {
    const transcript = await this.transcriptOf(input.projectId, input.workspaceId);
    const rows = await this.repository.allChunks(transcript.id, transcript.currentRevision);
    const words = rows
      .flatMap((row) => row.words as unknown as { wid: string; t: string; deleted?: boolean }[])
      .filter((word) => word.deleted !== true)
      .map((word) => ({ wid: word.wid, t: word.t }));

    if (words.length === 0) {
      throw new AppException(
        ERROR_CODES.validationFailed,
        "This transcript has no words to transliterate.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const jobKey = `transliterate:${transcript.id}:${input.script}`;
    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.transliterate",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      jobKey,
      // Free (09 §4 / 04 §Credits): no burn rate exists for this operation.
      worstCaseTenths: 0,
      reason: `ai.transliterate · ${String(words.length)} words · ${input.script}`,
      params: {
        transcriptId: transcript.id,
        language: transcript.language,
        targetScript: input.script,
        words,
      },
    });

    return {
      jobId: job.id,
      targetScript: input.script,
      status: job.status,
      deduplicated,
    };
  }

  /**
   * `POST /projects/{id}/transcript/translate` — one `ai.translate` job per
   * target language, each quoted and held on its own (CONTRACTS §4: a hold is
   * per job, and a partial failure must not hold credits for targets that were
   * never enqueued).
   */
  async translate(input: TranslateInput): Promise<TranslateAccepted> {
    if (input.targets.length > MAX_TRANSLATE_TARGETS) {
      throw new AppException(
        ERROR_CODES.validationFailed,
        `At most ${String(MAX_TRANSLATE_TARGETS)} targets per request.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.assertTranslationAllowed(input.workspaceId, input.targets);

    const transcript = await this.transcriptOf(input.projectId, input.workspaceId);
    const media = await this.primaryMedia(input.projectId);
    const document = await this.edg.document(input.projectId, input.workspaceId);
    const chunkRows = await this.repository.allChunks(transcript.id, transcript.currentRevision);
    const chunks = chunkRows.map((row): TranscriptChunk => ({
      chunkIdx: row.chunkIdx,
      startMs: row.startMs,
      endMs: row.endMs,
      words: row.words as unknown as TranscriptChunk["words"],
    }));
    const segments = await this.allSegments(input.projectId, input.workspaceId);
    const sources = segmentSourceTexts({
      transcriptId: transcript.id,
      revision: transcript.currentRevision,
      language: transcript.language,
      chunks,
      segments,
    });
    if (sources.length === 0) {
      throw new AppException(
        ERROR_CODES.validationFailed,
        "This project has no captions to translate yet.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const glossaryTerms = await this.glossary.terms(input.workspaceId);
    const glossary = glossaryTerms.flatMap((term) => [term.term, ...(term.aliases ?? [])]);

    const results: TranslateTargetAccepted[] = [];
    for (const target of input.targets) {
      const tenths = creditCostTenths({
        operation: "translation",
        durationMs: media.durationMs ?? 0,
        targetLanguages: 1,
      });
      const { job, deduplicated } = await this.jobs.enqueue({
        type: "ai.translate",
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        jobKey: `translate:${input.projectId}:${target}`,
        worstCaseTenths: tenths,
        reason: `ai.translate · ${target} · ${String(sources.length)} segments`,
        params: {
          sourceLanguage: transcript.language,
          targetLanguage: target,
          baseRevision: document.revision,
          glossary,
          segments: sources,
        },
      });
      results.push({
        jobId: job.id,
        targetLanguage: target,
        status: job.status,
        deduplicated,
        quote: { tenths, credits: formatCredits(tenths) },
      });
    }

    const totalTenths = results.reduce((sum, target) => sum + target.quote.tenths, 0);
    return {
      targets: [...results],
      quote: { tenths: totalTenths, credits: formatCredits(totalTenths) },
    };
  }

  // -------------------------------------------------------------------------
  // The internal write (worker -> API)
  // -------------------------------------------------------------------------

  /**
   * `POST /internal/transcripts/{id}/scripts` — a transliteration's word write.
   *
   * Unlike `TranscribeCompletionHandler`, this runs from the internal write
   * itself, not from the job's completion callback: `ai.transliterate`'s
   * completion handler is a formality (settling a zero-tenths hold) precisely
   * because the write — and the audit trail a "what changed" read needs — has
   * already happened here, before the job is even reported done.
   */
  async applyWordScripts(input: {
    readonly transcriptId: string;
    readonly jobId: string;
    readonly targetScript: "roman" | "native";
    readonly provider: string;
    readonly words: readonly ScriptWordInput[];
  }): Promise<InternalScriptsWriteAck> {
    let result;
    try {
      result = await this.scriptsRepository.applyWordScripts({
        transcriptId: input.transcriptId,
        targetScript: input.targetScript,
        words: input.words,
      });
    } catch (error) {
      if (error instanceof TranscriptNotFoundError) {
        throw new AppException(ERROR_CODES.notFound, "No such transcript.", HttpStatus.NOT_FOUND, {
          transcriptId: input.transcriptId,
        });
      }
      throw error;
    }

    await this.events.append({
      jobId: input.jobId,
      name: "transcript.scripts_updated",
      message: `${String(result.wordsUpdated)} words -> ${input.targetScript}`,
      data: {
        script: input.targetScript,
        provider: input.provider,
        wordsUpdated: result.wordsUpdated,
        revision: result.revision,
      },
    });

    this.logger.log(
      {
        transcriptId: input.transcriptId,
        targetScript: input.targetScript,
        wordsUpdated: result.wordsUpdated,
        revision: result.revision,
      },
      "word scripts written",
    );

    return {
      transcriptId: input.transcriptId,
      revision: result.revision,
      wordsUpdated: result.wordsUpdated,
    };
  }

  /**
   * A22's translation completion handler calls this to record the language
   * tag on the EDG document's meta — see `ScriptsRepository.setTranslationLanguage`.
   */
  async recordTranslationLanguage(projectId: string, language: string): Promise<void> {
    await this.scriptsRepository.setTranslationLanguage(projectId, language);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** `GET /projects/{id}/transcript/scripts` — what is available, and where it came from. */
  async availableScripts(
    projectId: string,
    workspaceId: string,
  ): Promise<readonly ScriptAvailability[]> {
    const transcript = await this.transcriptOf(projectId, workspaceId);
    const rows = await this.repository.allChunks(transcript.id, transcript.currentRevision);
    const words = rows.flatMap(
      (row) => row.words as unknown as { scripts?: Record<string, string> }[],
    );
    const has = (script: "roman" | "native" | "en"): boolean =>
      words.some(
        (word) => typeof word.scripts?.[script] === "string" && word.scripts[script] !== "",
      );

    const segments = await this.allSegments(projectId, workspaceId);
    const translatedAvailable = segments.some(
      (segment) => typeof segment.textOverrides?.["translated"] === "string",
    );

    const provenance = await this.provenanceOf(projectId);

    const scripts: ScriptAvailability[] = [
      { script: "roman", available: has("roman"), ...provenance.roman },
      { script: "native", available: has("native"), ...provenance.native },
      { script: "en", available: has("en"), ...provenance.en },
      { script: "translated", available: translatedAvailable, ...provenance.translated },
    ];
    return scripts;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async transcriptOf(projectId: string, workspaceId: string): Promise<Transcript> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    const transcript = await this.repository.latest(projectId);
    if (transcript === null) {
      throw new AppException(
        ERROR_CODES.notFound,
        "This project has no transcript yet.",
        HttpStatus.NOT_FOUND,
      );
    }
    return transcript;
  }

  private async primaryMedia(projectId: string): Promise<{ durationMs: number | null }> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: { durationMs: true },
    });
    return media ?? { durationMs: null };
  }

  /** Every live segment of the project's editing document, walking every page. */
  private async allSegments(projectId: string, workspaceId: string): Promise<Segment[]> {
    const segments: Segment[] = [];
    let cursor: string | undefined;
    for (;;) {
      let page;
      try {
        page = await this.edg.segments(projectId, workspaceId, cursor, 1_000);
      } catch {
        return []; // edg/not_initialised: transcribed but never opened
      }
      segments.push(...page.segments);
      if (page.nextCursor === null) return segments;
      cursor = page.nextCursor;
    }
  }

  /**
   * Plan gating (04 §Plans): Free workspaces may not translate at all; only
   * Starter+ may ask for English; only Creator+ may ask for anything else.
   */
  private async assertTranslationAllowed(
    workspaceId: string,
    targets: readonly string[],
  ): Promise<void> {
    const plan = await resolveWorkspacePlan(this.prisma, workspaceId);
    if (PLAN_TIER[plan] < PLAN_TIER.starter) {
      throw new AppException(
        SCRIPTS_ERROR_CODES.planRequired,
        "Translation needs a Starter plan or above.",
        HttpStatus.PAYMENT_REQUIRED,
        { requiredPlan: "starter", currentPlan: plan },
      );
    }
    const nonEnglish = targets.filter((target) => baseLanguage(target) !== "en");
    if (nonEnglish.length > 0 && PLAN_TIER[plan] < PLAN_TIER.creator) {
      throw new AppException(
        SCRIPTS_ERROR_CODES.planRequired,
        "Translating to a language other than English needs a Creator plan or above.",
        HttpStatus.PAYMENT_REQUIRED,
        { requiredPlan: "creator", currentPlan: plan, targets: nonEnglish },
      );
    }
  }

  /** The latest job event per script, for `GET .../transcript/scripts`. */
  private async provenanceOf(
    projectId: string,
  ): Promise<Record<"roman" | "native" | "en" | "translated", Partial<ScriptAvailability>>> {
    const events = await this.prisma.jobEvent.findMany({
      where: {
        job: { projectId },
        OR: [
          { data: { path: ["event"], equals: "transcript.scripts_updated" } },
          { data: { path: ["event"], equals: "transcript.translated" } },
        ],
      },
      orderBy: { id: "desc" },
      take: 50,
      select: { data: true, at: true },
    });

    const result: Record<"roman" | "native" | "en" | "translated", Partial<ScriptAvailability>> = {
      roman: {},
      native: {},
      en: {},
      translated: {},
    };
    for (const event of events) {
      const data = event.data as Record<string, unknown> | null;
      if (data === null) continue;
      const script = data["script"];
      if (script === "roman" || script === "native") {
        if (result[script].updatedAt !== undefined) continue; // newest already recorded
        result[script] = {
          source: "transliteration",
          provider: typeof data["provider"] === "string" ? data["provider"] : null,
          updatedAt: event.at.toISOString(),
        };
      } else if (script === "translated") {
        if (result.translated.updatedAt !== undefined) continue;
        result.translated = {
          source: "translation",
          provider: typeof data["provider"] === "string" ? data["provider"] : null,
          language: typeof data["targetLanguage"] === "string" ? data["targetLanguage"] : undefined,
          updatedAt: event.at.toISOString(),
        };
      }
    }
    return result;
  }
}

/** BCP-47 base subtag, lower-cased: `"hi-Latn"` -> `"hi"`. */
function baseLanguage(tag: string): string {
  return tag.split("-")[0]?.toLowerCase() ?? tag.toLowerCase();
}

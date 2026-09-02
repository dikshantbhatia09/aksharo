import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { TRANSCRIPT_EXPORT_FORMATS } from "./transcript-export.js";
import {
  MAX_TRANSCRIBE_HINTS,
  MAX_TRANSCRIBE_LANGUAGES,
  MAX_TRANSCRIPT_CHUNK_PAGE_SIZE,
} from "./transcripts.errors.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";

/**
 * Request and response shapes for `/projects/{id}/transcript*`.
 *
 * **Requests** are Zod, validated by the global pipe. **Responses** are classes,
 * because `pnpm gen:client` reads decorator metadata and a Zod schema leaves none
 * behind — the same split `edg.dto.ts` makes, and for the same reason. Words and
 * chunks are declared as opaque objects there and typed precisely in TypeScript:
 * the generated client re-exports `Word` and `TranscriptChunk` from `@montaj/edg`
 * rather than carrying a second copy of shapes CONTRACTS §2 has frozen.
 */

/** A BCP-47-ish tag: two or three letters, then optional script/region subtags. */
const LanguageTag = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Not a BCP-47 language tag.");

const CaptionPreferences = z.object({
  maxLines: z.number().int().min(1).max(3).optional(),
  minMs: z.number().int().min(200).max(3_000).optional(),
  maxMs: z.number().int().min(1_000).max(12_000).optional(),
  maxChars: z.number().int().min(12).max(60).optional(),
  dropFillers: z.boolean().optional(),
  styleRef: z.string().trim().min(1).max(64).optional(),
});

const TranscribeRequest = z.object({
  /**
   * Language hints, best first. The first is passed to the provider; naming more
   * than one is what tells the router this is code-mixed speech.
   */
  languages: z.array(LanguageTag).max(MAX_TRANSCRIBE_LANGUAGES).default([]),
  /** Glossary terms: hotword prompts where the provider supports them, post-correction otherwise. */
  hints: z.array(z.string().trim().min(1).max(64)).max(MAX_TRANSCRIBE_HINTS).default([]),
  /** Ask for speaker labels. Free — the transcription rate includes diarisation. */
  diarise: z.boolean().optional(),
  captions: CaptionPreferences.optional(),
});

export class TranscribeRequestDto extends zodDto(TranscribeRequest) {}

const RetranscribeRequest = TranscribeRequest.extend({
  /** Proceed even though the captions have been edited (`transcript/has_edits`). */
  force: z.boolean().default(false),
});

export class RetranscribeRequestDto extends zodDto(RetranscribeRequest) {}

/**
 * A22: which script's text to read. `roman` | `native` | `en` project a
 * per-word variant (falling back to the word's primary text); `translated`
 * reads the segment-level translation override. Omitted keeps the pre-A22
 * default.
 */
const ScriptQuery = z.enum(["roman", "native", "en", "translated"]);

const TranscriptQuery = z.object({
  /** The previous page's `nextCursor`: the last `chunkIdx` returned. */
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TRANSCRIPT_CHUNK_PAGE_SIZE).optional(),
  revision: z.coerce.number().int().min(1).optional(),
  script: ScriptQuery.optional(),
});

export class TranscriptQueryDto extends zodDto(TranscriptQuery) {}

const ExportQuery = z.object({
  format: z.enum(TRANSCRIPT_EXPORT_FORMATS).default("srt"),
  revision: z.coerce.number().int().min(1).optional(),
  /** Leave tagged fillers out, as the captions do. */
  dropFillers: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .optional(),
  script: ScriptQuery.optional(),
});

export class ExportQueryDto extends zodDto(ExportQuery) {}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class TranscriptionQuoteDto {
  @ApiProperty({ description: "Credits held before the job was enqueued, in tenths." })
  tenths!: number;

  @ApiProperty({ description: '"1.2" — for display only, never for arithmetic.' })
  credits!: string;

  @ApiProperty({ description: "Media duration the quote was computed from." })
  durationMs!: number;
}

export class TranscribeAcceptedDto {
  @ApiProperty({ description: "Poll `GET /jobs/{id}` or listen for `job.completed`." })
  jobId!: string;

  @ApiProperty({ description: "The transcript the completion will write." })
  transcriptId!: string;

  @ApiProperty({ description: "`queued`, or the live job's status when deduplicated." })
  status!: string;

  @ApiProperty({
    description: "True when a transcription was already running and none was enqueued.",
  })
  deduplicated!: boolean;

  @ApiProperty({ type: TranscriptionQuoteDto })
  quote!: TranscriptionQuoteDto;
}

export class DetectedLanguageDto {
  @ApiProperty({ description: "BCP-47 tag." })
  language!: string;

  @ApiProperty({ description: "0–1." })
  confidence!: number;

  @ApiProperty({ enum: ["provider", "script"], description: "Which of the two LID signals (D14)." })
  source!: string;
}

export class CorrectionDto {
  @ApiProperty({ enum: ["punctuation", "numerals", "glossary", "spelling", "fillers", "speakers"] })
  step!: string;

  @ApiProperty({ description: 'Word id, `"<chunkIdx>:<n>"`.' })
  wordId!: string;

  @ApiProperty({ description: "The text as the provider sent it." })
  before!: string;

  @ApiProperty({ description: "The text as it was stored." })
  after!: string;

  @ApiPropertyOptional({ description: "Why, in a form a human can review." })
  reason?: string;
}

export class PostProcessingDto {
  @ApiProperty({ type: [String], description: "Steps that actually changed something." })
  steps!: string[];

  @ApiProperty({ description: "Total corrections, including any not listed." })
  correctionCount!: number;

  @ApiProperty({ type: [CorrectionDto] })
  corrections!: CorrectionDto[];

  @ApiProperty({ description: "True when `corrections` is a prefix of the full log." })
  truncated!: boolean;

  @ApiProperty({ description: "True when the acoustic and orthographic LID signals disagreed." })
  languageDisagreement!: boolean;
}

export class TranscriptDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;

  @ApiProperty({ description: "Transcript revision these chunks belong to." })
  revision!: number;

  @ApiProperty({ description: "Resolved BCP-47 tag; Hinglish is `hi-Latn`." })
  language!: string;

  @ApiProperty({ type: [DetectedLanguageDto], description: "Both LID signals (D14)." })
  detectedLanguages!: DetectedLanguageDto[];

  @ApiPropertyOptional({ nullable: true }) provider?: string | null;
  @ApiPropertyOptional({ nullable: true }) model?: string | null;
  @ApiPropertyOptional({ nullable: true }) alignerModel?: string | null;
  @ApiPropertyOptional({ nullable: true }) diariser?: string | null;

  @ApiProperty({ description: "Chunks in this revision." })
  chunkCount!: number;

  @ApiProperty({ description: "End of the last chunk, in media ms." })
  durationMs!: number;

  @ApiProperty() createdAt!: string;

  @ApiPropertyOptional({ type: PostProcessingDto })
  postProcessing?: PostProcessingDto;
}

export class TranscriptChunkPageDto {
  @ApiProperty({ type: TranscriptDto })
  transcript!: TranscriptDto;

  @ApiProperty({
    type: "array",
    items: { type: "object", additionalProperties: true },
    description:
      "`TranscriptChunk` from `@montaj/edg` (CONTRACTS §2): `{chunkIdx, startMs, endMs, words[]}`.",
  })
  chunks!: unknown[];

  @ApiProperty({
    nullable: true,
    type: Number,
    description: "Last `chunkIdx` returned; pass as `cursor`. `null` at the end.",
  })
  nextCursor!: number | null;
}

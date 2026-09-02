import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { MAX_INTERNAL_SCRIPTS_WORDS, MAX_TRANSLATE_TARGETS } from "./scripts.errors.js";
import { zodDto } from "../../common/validation/zod-validation.pipe.js";

/**
 * Request and response shapes for `/projects/{id}/transcript/{translate,
 * transliterate,scripts}` and the internal `/internal/transcripts/{id}/scripts`
 * write path (A22).
 */

const LanguageTag = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Not a BCP-47 language tag.");

// ---------------------------------------------------------------------------
// Public requests
// ---------------------------------------------------------------------------

const TransliterateRequest = z.object({
  /** `roman` writes `word.scripts.roman`; `native` writes `word.scripts.native`. */
  script: z.enum(["roman", "native"]),
});

export class TransliterateRequestDto extends zodDto(TransliterateRequest) {}

const TranslateRequest = z.object({
  /** Target language tags, e.g. `["en", "hi"]`. */
  targets: z.array(LanguageTag).min(1).max(MAX_TRANSLATE_TARGETS),
  /** The only mode there is today; named so a future whole-document mode has a place. */
  mode: z.literal("segment").default("segment"),
});

export class TranslateRequestDto extends zodDto(TranslateRequest) {}

// ---------------------------------------------------------------------------
// Internal request (worker -> API, HMAC-signed)
// ---------------------------------------------------------------------------

const InternalScriptsWordSchema = z.object({
  wid: z.string().regex(/^\d+:\d+$/, "A word id is `<chunkIdx>:<n>` (CONTRACTS §2)."),
  text: z.string(),
});

const InternalScriptsWriteRequest = z.object({
  jobId: z.string().min(1),
  targetScript: z.enum(["roman", "native"]),
  provider: z.string().min(1).max(64),
  words: z.array(InternalScriptsWordSchema).min(1).max(MAX_INTERNAL_SCRIPTS_WORDS),
});

export class InternalScriptsWriteDto extends zodDto(InternalScriptsWriteRequest) {}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class TranslationQuoteDto {
  @ApiProperty({ description: "Credits held for this job, in tenths." })
  tenths!: number;

  @ApiProperty({ description: '"1.5" — for display only, never for arithmetic.' })
  credits!: string;
}

export class TransliterateAcceptedDto {
  @ApiProperty({ description: "Poll `GET /jobs/{id}` or listen for `job.completed`." })
  jobId!: string;

  @ApiProperty({ enum: ["roman", "native"] })
  targetScript!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({
    description: "True when a transliteration to this script was already running.",
  })
  deduplicated!: boolean;
}

export class TranslateTargetAcceptedDto {
  @ApiProperty()
  jobId!: string;

  @ApiProperty({ description: "BCP-47 tag this job translates to." })
  targetLanguage!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ description: "True when a translation to this language was already running." })
  deduplicated!: boolean;

  @ApiProperty({ type: TranslationQuoteDto })
  quote!: TranslationQuoteDto;
}

export class TranslateAcceptedDto {
  @ApiProperty({ type: [TranslateTargetAcceptedDto] })
  targets!: TranslateTargetAcceptedDto[];

  @ApiProperty({ type: TranslationQuoteDto, description: "Sum across every target." })
  quote!: TranslationQuoteDto;
}

export class ScriptAvailabilityDto {
  @ApiProperty({ enum: ["roman", "native", "en", "translated"] })
  script!: string;

  @ApiProperty()
  available!: boolean;

  @ApiPropertyOptional({ enum: ["transcription", "transliteration", "translation"] })
  source?: string;

  @ApiPropertyOptional({ nullable: true })
  provider?: string | null;

  @ApiPropertyOptional({ description: "For `translated`: the BCP-47 target it currently holds." })
  language?: string;

  @ApiPropertyOptional()
  updatedAt?: string;
}

export class AvailableScriptsDto {
  @ApiProperty({ type: [ScriptAvailabilityDto] })
  scripts!: ScriptAvailabilityDto[];
}

export interface InternalScriptsWriteAck {
  readonly transcriptId: string;
  readonly revision: number;
  readonly wordsUpdated: number;
}

import { Module } from "@nestjs/common";

import { ScriptsInternalController } from "./scripts-internal.controller.js";
import { ScriptsController } from "./scripts.controller.js";
import { ScriptsRepository } from "./scripts.repository.js";
import { ScriptsService } from "./scripts.service.js";
import { TranslateCompletionHandler } from "./translate.handler.js";
import { TransliterateCompletionHandler } from "./transliterate.handler.js";
import { EdgModule } from "../../edg/index.js";
import { InternalSignatureGuard } from "../../internal/internal-signature.guard.js";
import { JobsModule } from "../../jobs/jobs.module.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";
import { MemoryGlossarySource } from "../postprocess/index.js";
import { TranscriptsRepository } from "../transcripts.repository.js";

/**
 * Scripts and translation (A22): transliteration (`ai.transliterate`,
 * per-word `Word.scripts`) and translation (`ai.translate`, segment
 * `textOverrides.translated`) — the producers, the two completion handlers,
 * the internal write path transliteration needed of its own, and the read
 * that reports what a transcript has available.
 *
 * `TranscriptsRepository` is A11's — imported directly (not through
 * `TranscriptsModule`, which would also pull in `TranscribeCompletionHandler`
 * and everything transcription-only) because reading chunks and the latest
 * transcript is exactly the read surface this module needs and nothing about
 * transcription's own producer. `MemoryGlossarySource` is bound again here
 * rather than exported from `TranscriptsModule`, for the same reason
 * `WorkspaceMemberGuard` is (`transcripts.module.ts`'s own comment): it depends
 * on nothing but the global `PrismaService`, so a second binding is a second
 * instance of a stateless class, not a second implementation.
 */
@Module({
  imports: [JobsModule, EdgModule],
  controllers: [ScriptsController, ScriptsInternalController],
  providers: [
    ScriptsService,
    ScriptsRepository,
    TranscriptsRepository,
    MemoryGlossarySource,
    TransliterateCompletionHandler,
    TranslateCompletionHandler,
    WorkspaceMemberGuard,
    InternalSignatureGuard,
  ],
  exports: [ScriptsService],
})
export class ScriptsModule {}

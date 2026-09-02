import { Module } from "@nestjs/common";

import { MemoryGlossarySource } from "./postprocess/index.js";
import { TranscribeCompletionHandler } from "./transcribe.handler.js";
import { TranscriptsController } from "./transcripts.controller.js";
import { TranscriptsRepository } from "./transcripts.repository.js";
import { TranscriptsService } from "./transcripts.service.js";
import { EdgModule } from "../edg/index.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Transcripts: the producer, the reads, the exports and — the part that matters —
 * what an `ai.transcribe` completion *does* (A11).
 *
 * `JobsModule` for the producer (`JobsService.enqueue`) and for the registry the
 * handler registers itself with; `EdgModule` for `EdgService.initialise`, which is
 * A12's and is the only way this module writes an editing document.
 *
 * `WorkspaceMemberGuard` is declared here rather than imported: A05 provides it
 * inside `WorkspacesModule` without exporting it, and it depends on nothing but
 * the global `PrismaService`, so a second binding is a second instance of a
 * stateless class rather than a second implementation of the rule.
 */
@Module({
  imports: [JobsModule, EdgModule],
  controllers: [TranscriptsController],
  providers: [
    TranscriptsService,
    TranscriptsRepository,
    TranscribeCompletionHandler,
    MemoryGlossarySource,
    WorkspaceMemberGuard,
  ],
  exports: [TranscriptsService, TranscriptsRepository],
})
export class TranscriptsModule {}

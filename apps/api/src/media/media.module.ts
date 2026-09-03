import { Module } from "@nestjs/common";

import { SubtitleImportService } from "./import/subtitle-import.service.js";
import { MediaController, MediaUploadsController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { MediaProbeCompletionHandler } from "./probe.handler.js";
import { MediaProxyCompletionHandler } from "./proxy.handler.js";
import { RetentionService } from "./retention.service.js";
import { SampleProjectController } from "./sample-project.controller.js";
import { EdgModule } from "../edg/edg.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { AlignCompletionHandler } from "../replace-media/align-completion.handler.js";
import { ReplaceMediaAlignTrigger } from "../replace-media/replace-media-align.trigger.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Media ingest, derived URLs, subtitle import and the retention sweep (A06).
 *
 * `JobsModule` is imported because this is a producer for three CONTRACTS §3
 * queues — `media.probe`, `media.proxy` and `ai.align` — and every producer goes
 * through `JobsService.enqueue` rather than touching BullMQ. It is also where
 * `MediaProbeCompletionHandler` registers itself: a producer owns what its
 * completions *mean*, and this one turns a finished probe into a `media.proxy`
 * child job (A07).
 *
 * `RetentionService` is exported and registers no schedule of its own: B16 owns
 * the scheduler wiring, and a sweep that started itself in every process would
 * delete a shared bucket from a developer's laptop.
 *
 * `MediaProxyCompletionHandler` (A07b) is the completion-side half of what
 * `MediaProbeCompletionHandler` starts: it independently flips the asset to
 * `ready`/`failed` off the job's own completion, alongside (never instead of)
 * the worker's `PATCH /internal/media/{id}` write-back.
 *
 * `EdgModule` (B15 §5): `ReplaceMediaAlignTrigger` reads the current EDG
 * document to build the `ai.align` payload when a replaced media item's
 * `needs_realign` flag is set, and `AlignCompletionHandler` writes the
 * aligned timings back through `EdgService.applyWorkerOps` — both live in
 * `replace-media/` rather than forking `probe.handler.ts`'s own module, but
 * they are registered here because `MediaProbeCompletionHandler` is the only
 * caller of the trigger and this is where its own completion handler lives.
 */
@Module({
  imports: [ProjectsModule, WorkspacesModule, JobsModule, EdgModule, TranscriptsModule],
  controllers: [MediaController, MediaUploadsController, SampleProjectController],
  providers: [
    MediaService,
    SubtitleImportService,
    RetentionService,
    MediaProbeCompletionHandler,
    MediaProxyCompletionHandler,
    ReplaceMediaAlignTrigger,
    AlignCompletionHandler,
  ],
  exports: [MediaService, SubtitleImportService, RetentionService],
})
export class MediaModule {}

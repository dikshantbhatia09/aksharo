import { Module } from "@nestjs/common";

import { SubtitleImportService } from "./import/subtitle-import.service.js";
import { MediaController, MediaUploadsController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { MediaProbeCompletionHandler } from "./probe.handler.js";
import { RetentionService } from "./retention.service.js";
import { SampleProjectController } from "./sample-project.controller.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
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
 */
@Module({
  imports: [ProjectsModule, WorkspacesModule, JobsModule],
  controllers: [MediaController, MediaUploadsController, SampleProjectController],
  providers: [MediaService, SubtitleImportService, RetentionService, MediaProbeCompletionHandler],
  exports: [MediaService, SubtitleImportService, RetentionService],
})
export class MediaModule {}

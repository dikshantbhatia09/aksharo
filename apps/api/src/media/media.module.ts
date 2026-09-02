import { Module } from "@nestjs/common";

import { SubtitleImportService } from "./import/subtitle-import.service.js";
import { MediaController, MediaUploadsController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { RetentionService } from "./retention.service.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Media ingest, derived URLs, subtitle import and the retention sweep (A06).
 *
 * `JobsModule` is imported because this is a producer for three CONTRACTS §3
 * queues — `media.probe`, `media.proxy` and `ai.align` — and every producer goes
 * through `JobsService.enqueue` rather than touching BullMQ.
 *
 * `RetentionService` is exported and registers no schedule of its own: B16 owns
 * the scheduler wiring, and a sweep that started itself in every process would
 * delete a shared bucket from a developer's laptop.
 */
@Module({
  imports: [ProjectsModule, WorkspacesModule, JobsModule],
  controllers: [MediaController, MediaUploadsController],
  providers: [MediaService, SubtitleImportService, RetentionService],
  exports: [MediaService, SubtitleImportService, RetentionService],
})
export class MediaModule {}

import { Module } from "@nestjs/common";

import { BatchController } from "./batch.controller.js";
import { BatchService } from "./batch.service.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Batch orchestration (B15 brief §4): builds on `ProjectsModule`'s
 * `batchCreate` (A06) and `TranscriptsModule`'s `transcribe` (A11) rather than
 * reimplementing project creation or the `ai.transcribe` producer.
 */
@Module({
  imports: [ProjectsModule, TranscriptsModule, WorkspacesModule],
  controllers: [BatchController],
  providers: [BatchService],
  exports: [BatchService],
})
export class BatchModule {}

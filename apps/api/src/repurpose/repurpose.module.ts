import { Module } from "@nestjs/common";

import { RepurposeAcquireCompletionHandler } from "./acquire-completion.handler.js";
import { RepurposeClipCompletionHandler } from "./clip-completion.handler.js";
import { RepurposeHighlightsCompletionHandler } from "./highlights-completion.handler.js";
import { RepurposeTranscriptCompletedListener } from "./listeners/transcript-completed.listener.js";
import { RepurposeStuckRunsSweepTask } from "./repurpose-stuck-runs-sweep.task.js";
import { RepurposeController } from "./repurpose.controller.js";
import { RepurposeService } from "./repurpose.service.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { MediaModule } from "../media/media.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { IdempotencyService } from "../public-api/v1/idempotency.service.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { StylesModule } from "../styles/styles.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * REP-006: the guided repurposing run.
 */
@Module({
  imports: [
    ProjectsModule,
    MediaModule,
    StylesModule,
    WorkspacesModule,
    RealtimeModule,
    JobsModule,
  ],
  controllers: [RepurposeController],
  providers: [
    RepurposeService,
    RepurposeAcquireCompletionHandler,
    RepurposeHighlightsCompletionHandler,
    RepurposeClipCompletionHandler,
    RepurposeTranscriptCompletedListener,
    RepurposeStuckRunsSweepTask,
    IdempotencyService,
  ],
  exports: [RepurposeService],
})
export class RepurposeModule {}

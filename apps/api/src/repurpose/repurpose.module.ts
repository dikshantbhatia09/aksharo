import { Module } from "@nestjs/common";

import { RepurposeAcquireCompletionHandler } from "./acquire-completion.handler.js";
import { RepurposeClipCompletionHandler } from "./clip-completion.handler.js";
import { ClipFinishing } from "./clip-finishing.js";
import { RepurposeHighlightsCompletionHandler } from "./highlights-completion.handler.js";
import { RepurposeTranscriptCompletedListener } from "./listeners/transcript-completed.listener.js";
import { RepurposeReconciler } from "./reconciler.js";
import { RepurposeClipsService } from "./repurpose-clips.service.js";
import { RepurposeStuckRunsSweepTask } from "./repurpose-stuck-runs-sweep.task.js";
import { RepurposeController } from "./repurpose.controller.js";
import { RepurposeService } from "./repurpose.service.js";
import { SourceGate } from "./source-gate.js";
import { RepurposeStillsCompletionHandler } from "./stills-completion.handler.js";
import { EdgModule } from "../edg/index.js";
import { ExportsModule } from "../exports/exports.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { MediaModule } from "../media/media.module.js";
import { PassesModule } from "../passes/passes.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { IdempotencyService } from "../public-api/v1/idempotency.service.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { StylesModule } from "../styles/styles.module.js";
import { AutoTranscribeTrigger } from "../transcripts/auto-transcribe.trigger.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";
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
    // Autopilot's captioned clips are ordinary cloud exports of the clip project.
    ExportsModule,
    // Autopilot finishes each clip's edit first (`clip-finishing.ts`): the
    // autocut and zoom passes, and the document they and the hook title land in.
    PassesModule,
    EdgModule,
    // For `AutoTranscribeTrigger`'s own dependencies (the reconciler starts a
    // run's transcription through it).
    TranscriptsModule,
  ],
  controllers: [RepurposeController],
  providers: [
    RepurposeService,
    RepurposeAcquireCompletionHandler,
    RepurposeHighlightsCompletionHandler,
    RepurposeClipCompletionHandler,
    RepurposeStillsCompletionHandler,
    RepurposeTranscriptCompletedListener,
    RepurposeStuckRunsSweepTask,
    IdempotencyService,
    RepurposeClipsService,
    ClipFinishing,
    RepurposeReconciler,
    SourceGate,
    // A second binding of a stateless class (`MediaModule` provides the first
    // and does not export it), as `TranscriptsModule` does with its guard.
    AutoTranscribeTrigger,
  ],
  exports: [RepurposeService, RepurposeClipsService],
})
export class RepurposeModule {}

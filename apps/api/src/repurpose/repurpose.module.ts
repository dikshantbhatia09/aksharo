import { Module } from "@nestjs/common";

import { RepurposeAcquireCompletionHandler } from "./acquire-completion.handler.js";
import { RepurposeClipCompletionHandler } from "./clip-completion.handler.js";
import { ClipFinishing } from "./clip-finishing.js";
import { ClipTrimController } from "./clip-trim.controller.js";
import { RepurposeCompilationCompletionHandler } from "./compilation-completion.handler.js";
import { RepurposeCompilationsController } from "./compilations.controller.js";
import { RepurposeCompilationsService } from "./compilations.service.js";
import { DubBudget } from "./dubbing/dub-budget.js";
import { RepurposeDubCompletionHandler } from "./dubbing/dub-completion.handler.js";
import { RepurposeDubMuxCompletionHandler } from "./dubbing/dub-mux-completion.handler.js";
import { RepurposeDubsController } from "./dubbing/dubs.controller.js";
import { RepurposeDubsService } from "./dubbing/dubs.service.js";
import { RepurposeEpisodePackController } from "./episode-pack.controller.js";
import { RepurposeEpisodePackService } from "./episode-pack.service.js";
import { RepurposeExampleController } from "./example/example-run.controller.js";
import { ExampleRunService } from "./example/example-run.service.js";
import { RepurposeHighlightsCompletionHandler } from "./highlights-completion.handler.js";
import { RepurposeTranscriptCompletedListener } from "./listeners/transcript-completed.listener.js";
import { RepurposeReconciler } from "./reconciler.js";
import { RepurposeClipsService } from "./repurpose-clips.service.js";
import { RepurposeCoversController } from "./repurpose-covers.controller.js";
import { RepurposeSteeringController } from "./repurpose-steering.controller.js";
import { RepurposeSteeringService } from "./repurpose-steering.service.js";
import { RepurposeStuckRunsSweepTask } from "./repurpose-stuck-runs-sweep.task.js";
import { RepurposeController } from "./repurpose.controller.js";
import { RepurposeService } from "./repurpose.service.js";
import { RepurposeResultsController } from "./results/run-results.controller.js";
import { RepurposeResultsService } from "./results/run-results.service.js";
import { RunSearch } from "./results/run-search.js";
import { RunActivityReader } from "./run-activity.reader.js";
import { RunNotifier } from "./run-notifications.js";
import { RepurposeSeriesService } from "./series.service.js";
import { SourceGate } from "./source-gate.js";
import { RepurposeStillsCompletionHandler } from "./stills-completion.handler.js";
import { VoiceoverBudget } from "./voiceover/voiceover-budget.js";
import { RepurposeVoiceoverCompletionHandler } from "./voiceover/voiceover-completion.handler.js";
import { RepurposeVoiceoversController } from "./voiceover/voiceovers.controller.js";
import { RepurposeVoiceoversService } from "./voiceover/voiceovers.service.js";
import { BrandKitModule } from "../brand-kit/brand-kit.module.js";
import { BrollModule } from "../broll/broll.module.js";
import { EdgModule } from "../edg/index.js";
import { ExportsModule } from "../exports/exports.module.js";
import { InsightsModule } from "../insights/insights.module.js";
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
    // The episode text pack is an `ai.llm` job through the insights producer.
    InsightsModule,
    // Autopilot's finishing pass applies the workspace's brand kit to a run
    // that asks for it (2026-10-02).
    BrandKitModule,
    // ... and B-roll from the workspace's library, or stock photos (2026-10-05).
    BrollModule,
  ],
  controllers: [
    RepurposeController,
    RepurposeSteeringController,
    ClipTrimController,
    RepurposeEpisodePackController,
    // Compilations and series (2026-10-03).
    RepurposeCompilationsController,
    // A clip dubbed into other languages (2026-10-04).
    RepurposeDubsController,
    // A spoken hook at the start of a clip (2026-10-01, behind `repurpose_voiceover`).
    RepurposeVoiceoversController,
    // A run's cover, for the audiograms of a source with no picture (2026-10-04).
    RepurposeCoversController,
    // The results page: titles, hook titles, transcript, estimate (2026-10-01).
    RepurposeResultsController,
    // The finished example run any signed-in person may open, read only (2026-10-01).
    RepurposeExampleController,
  ],
  providers: [
    RepurposeService,
    RepurposeSteeringService,
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
    RepurposeEpisodePackService,
    SourceGate,
    // Progress and alerts (2026-09-29): the step a run is on, and its notifications.
    RunActivityReader,
    RunNotifier,
    // A run's clips joined into one video, and numbered series (2026-10-03).
    RepurposeCompilationsService,
    RepurposeCompilationCompletionHandler,
    RepurposeSeriesService,
    // A clip dubbed into other languages (2026-10-04): the vendor's job, then
    // each shape laid in each language, and the day's rupee budget.
    RepurposeDubsService,
    RepurposeDubCompletionHandler,
    RepurposeDubMuxCompletionHandler,
    DubBudget,
    // A spoken hook at the start of a clip (2026-10-01): the vendor's call, then
    // the voice laid on every shape's document, and the day's rupee budget.
    RepurposeVoiceoversService,
    RepurposeVoiceoverCompletionHandler,
    VoiceoverBudget,
    // A second binding of a stateless class (`MediaModule` provides the first
    // and does not export it), as `TranscriptsModule` does with its guard.
    AutoTranscribeTrigger,
    RepurposeResultsService,
    RunSearch,
    ExampleRunService,
  ],
  exports: [RepurposeService, RepurposeClipsService, RepurposeResultsService, RunSearch],
})
export class RepurposeModule {}

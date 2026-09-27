import { Module } from "@nestjs/common";

import { InternalJobsController } from "./internal-jobs.controller.js";
import { InternalMediaController } from "./internal-media.controller.js";
import { InternalSignatureGuard } from "./internal-signature.guard.js";
import { InternalRoutingOverridesController } from "./routing-overrides.controller.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { AutoTranscribeTrigger } from "../transcripts/auto-transcribe.trigger.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";

/**
 * The signed worker → API surface (CONTRACTS §3).
 *
 * Kept in its own module rather than inside `jobs` so the guard is the *only* way
 * in: every controller registered here is behind {@link InternalSignatureGuard},
 * and a route that needs it cannot be added anywhere else by accident.
 */
@Module({
  // TranscriptsModule for `AutoTranscribeTrigger`'s own dependencies: the media
  // write-back starts a first transcription on the early audio.
  imports: [JobsModule, TranscriptsModule],
  controllers: [
    InternalJobsController,
    InternalMediaController,
    InternalRoutingOverridesController,
  ],
  providers: [
    InternalSignatureGuard,
    // A second binding of a stateless class, as RepurposeModule has.
    AutoTranscribeTrigger,
  ],
  exports: [InternalSignatureGuard],
})
export class InternalModule {}

import { Module } from "@nestjs/common";

import { BulkRunsService } from "./bulk-runs.service.js";
import { BulkRunsController, SourceWatchController } from "./source-watch.controller.js";
import { SourceWatchPoller } from "./source-watch.poller.js";
import { SourceWatchService } from "./source-watch.service.js";
import { WatchNotifier } from "./watch-notices.js";
import { CHANNEL_DIRECTORY, YouTubeChannelDirectory } from "./youtube-channels.js";
import { SafeYouTubeHttp } from "./youtube-http.js";
import { IdempotencyService } from "../../public-api/v1/idempotency.service.js";
import { StylesModule } from "../../styles/styles.module.js";
import { RepurposeModule } from "../repurpose.module.js";
import { SourceGate } from "../source-gate.js";

import type { Provider } from "@nestjs/common";

/**
 * The module's own providers, exported for `automations.module.test.ts`.
 *
 * `SourceGate` and `IdempotencyService` are second bindings of stateless
 * classes `RepurposeModule` provides and does not export - the gate's state is
 * in Redis, the keys in the database - as `RepurposeModule` does itself with
 * `AutoTranscribeTrigger`.
 */
export const AUTOMATIONS_PROVIDERS: Provider[] = [
  SourceWatchService,
  SourceWatchPoller,
  WatchNotifier,
  BulkRunsService,
  IdempotencyService,
  SourceGate,
  {
    provide: CHANNEL_DIRECTORY,
    useFactory: (gate: SourceGate) => new YouTubeChannelDirectory(new SafeYouTubeHttp(), gate),
    inject: [SourceGate],
  },
];

/**
 * Set-and-forget clips (2026-10-02): channel automations (`/repurpose/watches`,
 * the `repurpose.source-watch` task) and several links at once
 * (`/repurpose/runs/bulk`). Everything answers 404, and the task starts
 * nothing, until `repurpose_automations` is on for a workspace (a missing flag
 * row is off) together with `repurpose_flow` and `source_youtube_acquire`; and
 * the task itself runs only where `MONTAJ_SCHEDULER_TASKS` names it.
 */
@Module({
  imports: [RepurposeModule, StylesModule],
  controllers: [SourceWatchController, BulkRunsController],
  providers: AUTOMATIONS_PROVIDERS,
})
export class RepurposeAutomationsModule {}

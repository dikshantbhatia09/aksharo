import { Module } from "@nestjs/common";

import { ClipPostsService } from "./clip-posts.service.js";
import {
  POSTIZ_ANALYTICS,
  POSTIZ_READ_BUDGET,
  PerformanceRefresher,
  VIEW_READER,
} from "./performance-refresher.js";
import { postizReadsPerHour } from "./performance.constants.js";
import { RepurposePerformanceController, WhatWorksController } from "./performance.controller.js";
import { ReadBudget } from "./read-budget.js";
import { WhatWorksService } from "./what-works.service.js";
import { YouTubeViewReader } from "./youtube-views.js";
import {
  POSTIZ_CLIENT_OPTIONS,
  PostizClient,
  postizClientOptions,
} from "../../publishing/postiz/postiz.client.js";
import { SafeYouTubeHttp } from "../automations/youtube-http.js";
import { RepurposeModule } from "../repurpose.module.js";
import { SourceGate } from "../source-gate.js";

import type { Provider } from "@nestjs/common";

/**
 * The module's own providers, exported for the injector test.
 *
 * Its own `PostizClient`, on the same key and URL as posting's: the client's
 * breaker is per instance, so analytics reads that fail never make posting
 * wait, and posting never stops a read. `SourceGate` is a second binding of a
 * stateless class (its state is in Redis), as `RepurposeAutomationsModule`
 * has one.
 */
export const PERFORMANCE_PROVIDERS: Provider[] = [
  ClipPostsService,
  WhatWorksService,
  PerformanceRefresher,
  SourceGate,
  { provide: POSTIZ_CLIENT_OPTIONS, useFactory: postizClientOptions },
  PostizClient,
  { provide: POSTIZ_ANALYTICS, useExisting: PostizClient },
  {
    provide: VIEW_READER,
    useFactory: (gate: SourceGate) => new YouTubeViewReader(new SafeYouTubeHttp(), gate),
    inject: [SourceGate],
  },
  { provide: POSTIZ_READ_BUDGET, useFactory: () => new ReadBudget(postizReadsPerHour()) },
];

/**
 * Learn what works (2026-10-05): where a run's clips were posted and how each
 * post did (`/repurpose/runs/:runId/performance`), the workspace's "What
 * works" view (`/repurpose/performance/what-works`), and the
 * `repurpose.performance-refresh` task that reads the numbers. Everything
 * answers 404 (the run's list `enabled: false`) until `repurpose_performance`
 * is on for a workspace together with `repurpose_flow`; the task runs only
 * where `MONTAJ_SCHEDULER_TASKS` names it. The steering of a run's picks is
 * `RepurposeService.startHighlightDiscovery`'s, through `steering-signal.ts`.
 */
@Module({
  imports: [RepurposeModule],
  controllers: [RepurposePerformanceController, WhatWorksController],
  providers: PERFORMANCE_PROVIDERS,
})
export class RepurposePerformanceModule {}

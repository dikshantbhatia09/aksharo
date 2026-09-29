import { Module } from "@nestjs/common";

import { ChannelDirectory } from "./channel-directory.js";
import {
  POSTIZ_CLIENT_OPTIONS,
  PostizClient,
  postizClientOptions,
} from "./postiz/postiz.client.js";
import { PublishDispatcher } from "./publish-dispatcher.js";
import { PublishQueue } from "./publish-queue.js";
import { PublishWorker } from "./publish-worker.js";
import { PublishingAccess } from "./publishing-access.js";
import { PublishingController, RepurposePublishingController } from "./publishing.controller.js";
import { PublishingService } from "./publishing.service.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { IdempotencyService } from "../public-api/v1/idempotency.service.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Posting clips to social accounts through Postiz (2026-09-29): the Postiz
 * client, the channel mirror, the post ledger's routes, and the in-process
 * consumer of `publish.dispatch` / `publish.reconcile` with its watchdog.
 *
 * Gated by `publishing_postiz` (seeded off), `POSTIZ_WORKSPACE_IDS` and
 * `POSTIZ_API_KEY`: without all three nothing here posts, and without a key
 * the consumer does not even start. `docs/publishing/POSTIZ-SETUP.md` is the
 * owner's side of it. `PrismaService`, `RedisService`, the object stores and
 * `CommonAuditService` come from the global `common` modules.
 */
/** The module's providers, exported for the injector test. */
export const PUBLISHING_PROVIDERS = [
  { provide: POSTIZ_CLIENT_OPTIONS, useFactory: postizClientOptions },
  PostizClient,
  PublishingAccess,
  ChannelDirectory,
  PublishQueue,
  PublishDispatcher,
  PublishWorker,
  PublishingService,
  // A second binding of a stateless class, as `RepurposeModule` has.
  IdempotencyService,
];

@Module({
  imports: [JobsModule, WorkspacesModule],
  controllers: [PublishingController, RepurposePublishingController],
  providers: PUBLISHING_PROVIDERS,
})
export class PublishingModule {}

import { Global, Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { createMailProvider } from "./mail/mail.factory.js";
import { MAIL_PROVIDER } from "./mail/mail.provider.js";
import { NOTIFICATION_CHANNELS } from "./notify.channels.js";
import { NotifyConsumer } from "./notify.consumer.js";
import { NotifyController } from "./notify.controller.js";
import { NotifyService } from "./notify.service.js";
import { webPushSetting } from "./push/push-env.js";
import { PushSubscriptionsService } from "./push/push-subscriptions.service.js";
import { WEB_PUSH_SETTING, WebPushChannel } from "./push/push.channel.js";
import { PushController } from "./push/push.controller.js";
import { CERTIFICATE_FETCHER, MailEventsController } from "./sns/mail-events.controller.js";
import { SnsBodyMiddleware } from "./sns/sns-body.middleware.js";
import { fetchSigningCertificate } from "./sns/sns-message.js";
import { SuppressionService } from "./suppression.service.js";
import { RateLimitService, RedisService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { JobsModule } from "../jobs/jobs.module.js";

import type { MailProvider } from "./mail/mail.provider.js";

/**
 * Transactional mail and in-app notifications.
 *
 * `@Global()` for one reason: `AuthMailerService` (A04) injects
 * {@link NotifyService}, and A04's module is itself `@Global()` and imported
 * before this one. Exporting globally is what lets a producer — auth today,
 * billing's pre-debit notices and exports tomorrow — enqueue a message without
 * importing anything, which is the same argument `RealtimeModule` makes.
 *
 * `JobsModule` is the only import, for {@link QueueRegistry}: `notify` is a
 * CONTRACTS section 3 queue and its BullMQ `Queue` must come from the one
 * registry that owns the prefix and the connection, not from a second one.
 *
 * `RateLimitService` is listed again here rather than imported from `AuthModule`.
 * It is a two-field wrapper over one Lua script with no state of its own, and
 * depending on the auth module for it would tie mail delivery to the auth graph
 * for no benefit.
 */
@Global()
@Module({
  imports: [JobsModule],
  controllers: [NotifyController, MailEventsController, PushController],
  providers: [
    NotifyService,
    NotifyConsumer,
    SuppressionService,
    RateLimitService,
    PushSubscriptionsService,
    WebPushChannel,
    // Read once, at boot: a key pair is not something that changes under a
    // running process, and an unusable one is logged once rather than per send.
    { provide: WEB_PUSH_SETTING, useFactory: () => webPushSetting() },
    // Every device channel `NotifyService` fans a device kind out to
    // (`notify.channels.ts`). Another channel is one more entry here.
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (push: WebPushChannel) => [push],
      inject: [WebPushChannel],
    },
    {
      // Chosen once, at boot, from `MAIL_PROVIDER`. A misconfigured transport
      // throws here and the process does not start, which is the point: a queue
      // quietly filling with undeliverable jobs is worse than a failed deploy.
      provide: MAIL_PROVIDER,
      useFactory: (env: Env, redis: RedisService): MailProvider =>
        createMailProvider(env, redis.client),
      inject: [ENV, RedisService],
    },
    { provide: CERTIFICATE_FETCHER, useValue: fetchSigningCertificate },
  ],
  exports: [NotifyService, NotifyConsumer, SuppressionService, MAIL_PROVIDER, WebPushChannel],
})
export class NotifyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // SNS posts `text/plain`, which the global JSON parser skips. Applied to the
    // one route rather than widening the parser for the whole API.
    consumer.apply(SnsBodyMiddleware).forRoutes("internal/mail/events");
  }
}

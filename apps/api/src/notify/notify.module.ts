import { Global, Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { createMailProvider } from "./mail/mail.factory.js";
import { MAIL_PROVIDER } from "./mail/mail.provider.js";
import { NotifyConsumer } from "./notify.consumer.js";
import { NotifyController } from "./notify.controller.js";
import { NotifyService } from "./notify.service.js";
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
  controllers: [NotifyController, MailEventsController],
  providers: [
    NotifyService,
    NotifyConsumer,
    SuppressionService,
    RateLimitService,
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
  exports: [NotifyService, NotifyConsumer, SuppressionService, MAIL_PROVIDER],
})
export class NotifyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // SNS posts `text/plain`, which the global JSON parser skips. Applied to the
    // one route rather than widening the parser for the whole API.
    consumer.apply(SnsBodyMiddleware).forRoutes("internal/mail/events");
  }
}

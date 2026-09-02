import { Module } from "@nestjs/common";

import { ConsentsController } from "./consents.controller.js";
import { ConsentsService } from "./consents.service.js";
import { UsersModule } from "../users/users.module.js";

/**
 * Granular, per-purpose consent and its append-only record (D61, D62).
 *
 * Imports `UsersModule` for the shared `AuditService`; the consent rows
 * themselves are written straight through Prisma, because a consent record has to
 * land in the same transaction as the `users` column it mirrors.
 */
@Module({
  imports: [UsersModule],
  controllers: [ConsentsController],
  providers: [ConsentsService],
  exports: [ConsentsService],
})
export class ConsentsModule {}

import { Module } from "@nestjs/common";

import { AuditService } from "./audit.service.js";
import { DataExportService } from "./data-export.service.js";
import { ProductEventsService } from "./onboarding/product-events.service.js";
import { ProfileService } from "./profile.service.js";
import { UsersController } from "./users.controller.js";
import { UsersService } from "./users.service.js";

/**
 * Accounts: the minimal surface A04 needs (create a user with a personal
 * workspace, look one up, answer membership questions) plus the `/me` routes A05
 * adds — profile, the DPDP data export and the erasure request.
 *
 * It also owns `AuditService`, the `audit_log` + `access_logs` writer every other
 * A05 module uses. That is why `workspaces`, `consents` and `privacy` all import
 * this module: a mutation without an audit row is a mutation nobody can account
 * for, and the writer has to live somewhere all of them can reach.
 *
 * Nothing here imports `auth`: `AuthModule` imports *this* one, and the guards it
 * publishes are global.
 */
@Module({
  controllers: [UsersController],
  providers: [AuditService, DataExportService, ProductEventsService, ProfileService, UsersService],
  exports: [AuditService, DataExportService, ProductEventsService, ProfileService, UsersService],
})
export class UsersModule {}

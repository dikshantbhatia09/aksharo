import { Module } from "@nestjs/common";

import { AdminUsersController } from "./admin-users.controller.js";
import { AdminUsersService } from "./admin-users.service.js";
import { AdminModule } from "../admin.module.js";

/**
 * Its own module for the same reason `AdminBillingModule` is: needs
 * `AdminGuard` from `AdminModule`, and keeping every panel that only needs
 * `AdminModule` plus its own feature module in a small module of its own
 * avoids growing `AdminModule`'s own import list (and any future cycle) as
 * B13's remaining increments land.
 */
@Module({
  imports: [AdminModule],
  controllers: [AdminUsersController],
  providers: [AdminUsersService],
})
export class AdminUsersModule {}

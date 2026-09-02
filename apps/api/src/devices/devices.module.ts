import { Module } from "@nestjs/common";

import { DevicesController } from "./devices.controller.js";
import { DevicesService } from "./devices.service.js";
import { UsersModule } from "../users/users.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Device registration and management (brief §2). Imports `WorkspacesModule`
 * for `EntitlementService` (per-plan, per-seat device limit) and
 * `WorkspaceMemberGuard`, `UsersModule` for `AuditService`.
 */
@Module({
  imports: [WorkspacesModule, UsersModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}

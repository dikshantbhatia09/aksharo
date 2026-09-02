import { Module } from "@nestjs/common";

import { SupportController } from "./support.controller.js";
import { SupportService } from "./support.service.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Support tickets (B12). `WorkspaceMemberGuard` from `WorkspacesModule`;
 * `NotifyService` is global (`NotifyModule`), so it needs no import here.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}

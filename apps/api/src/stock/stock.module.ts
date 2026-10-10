import { Module } from "@nestjs/common";

import { StockController } from "./stock.controller.js";
import { StockService } from "./stock.service.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * Integrated Stock Media Library Module (Pillar 6 §02).
 */
@Module({
  controllers: [StockController],
  providers: [StockService, WorkspaceMemberGuard],
  exports: [StockService],
})
export class StockModule {}

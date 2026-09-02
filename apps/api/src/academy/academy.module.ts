import { Module } from "@nestjs/common";

import { AcademyController } from "./academy.controller.js";
import { AcademyService } from "./academy.service.js";
import { AcademyExportCompletedListener } from "./export-completed.listener.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Academy tracks/progress/rewards + What's-new dismissal (B12).
 *
 * `WorkspacesModule` for `WorkspaceMemberGuard`; `CREDITS_FACADE` and
 * `EventEmitter2` are both global already, so neither needs an import here —
 * `AcademyExportCompletedListener` picks up `export.completed` purely
 * through `@OnEvent`, same as `ReferralsModule`.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [AcademyController],
  providers: [AcademyService, AcademyExportCompletedListener],
  exports: [AcademyService],
})
export class AcademyModule {}

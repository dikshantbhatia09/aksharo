import { Module } from "@nestjs/common";

import { StylePresetsController } from "./style-presets.controller.js";
import { StylesController } from "./styles.controller.js";
import { StylesService } from "./styles.service.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * The style catalogue and a workspace's custom presets (A14).
 *
 * `WorkspacesModule` is imported for `WorkspaceMemberGuard`, which every route
 * here wears — `GET /styles` re-checks membership from the token's `ws` claim
 * (no `:id`), and every `/workspaces/{id}/style-presets` route proves the path
 * id against it (THREAT-MODEL T4). Everything else — Prisma, the validation
 * pipe — comes from the global `CommonModule`.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [StylesController, StylePresetsController],
  providers: [StylesService],
  exports: [StylesService],
})
export class StylesModule {}

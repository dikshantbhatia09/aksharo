import { Module } from "@nestjs/common";

import { BrandKitController } from "./brand-kit.controller.js";
import { BrandKitService } from "./brand-kit.service.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * A workspace's brand kit (2026-10-02): the settings page's routes, and the
 * service Autopilot's finishing pass, the render payload and the previews read
 * the kit and its logos through. `PrismaService`, the object stores and the
 * audit writer come from the global common bindings.
 */
@Module({
  controllers: [BrandKitController],
  providers: [BrandKitService, WorkspaceMemberGuard],
  exports: [BrandKitService],
})
export class BrandKitModule {}

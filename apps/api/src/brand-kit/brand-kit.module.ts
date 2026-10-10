import { Module } from "@nestjs/common";

import { BrandKitController } from "./brand-kit.controller.js";
import { BrandKitService } from "./brand-kit.service.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import { WorkspaceBrandKitController } from "./workspace-brand-kit.controller.js";
import { WorkspaceBrandKitService } from "./workspace-brand-kit.service.js";

/**
 * A workspace's brand kit (2026-10-02): the settings page's routes, and the
 * service Autopilot's finishing pass, the render payload and the previews read
 * the kit and its logos through. `PrismaService`, the object stores and the
 * audit writer come from the global common bindings.
 */
@Module({
  controllers: [BrandKitController, WorkspaceBrandKitController],
  providers: [BrandKitService, WorkspaceBrandKitService, WorkspaceMemberGuard],
  exports: [BrandKitService, WorkspaceBrandKitService],
})
export class BrandKitModule {}

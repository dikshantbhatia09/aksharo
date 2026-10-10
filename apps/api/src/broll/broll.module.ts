import { Module } from "@nestjs/common";

import { BrollController } from "./broll.controller.js";
import { BrollLibraryService } from "./broll.service.js";
import { PexelsClient, pexelsSetting } from "./pexels.client.js";
import { StockProviderService } from "./stock-provider.service.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * A workspace's B-roll library (2026-10-05): the library page's and the
 * editor's routes, and the service Autopilot's finishing pass, the render
 * payload and the previews read pictures through. The stock photo client reads
 * `PEXELS_API_KEY` once, at boot: without it, stock photos are off.
 * `PrismaService`, the object stores and the audit writer come from the global
 * common bindings.
 */
@Module({
  controllers: [BrollController],
  providers: [
    BrollLibraryService,
    StockProviderService,
    WorkspaceMemberGuard,
    { provide: PexelsClient, useFactory: () => new PexelsClient(pexelsSetting()) },
  ],
  exports: [BrollLibraryService, StockProviderService],
})
export class BrollModule {}

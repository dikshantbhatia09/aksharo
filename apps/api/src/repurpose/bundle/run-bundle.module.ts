import { Module } from "@nestjs/common";

import { PublicRunDownloadController, RunBundleController } from "./run-bundle.controller.js";
import { RunBundleService } from "./run-bundle.service.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";
import { ClipReviewModule } from "../review/clip-review.module.js";

/** "Download all" (2026-10-01): a run's clips, every shape, as one streamed ZIP. */
@Module({
  imports: [WorkspacesModule, ClipReviewModule],
  controllers: [RunBundleController, PublicRunDownloadController],
  providers: [RunBundleService],
})
export class RepurposeBundleModule {}

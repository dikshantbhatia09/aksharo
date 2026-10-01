import { Module } from "@nestjs/common";

import {
  ClipNleDownloadController,
  PublicNleDownloadController,
} from "./nle-download.controller.js";
import { ClipNleDownloadService } from "./nle-download.service.js";
import { PublicRunDownloadController, RunBundleController } from "./run-bundle.controller.js";
import { RunBundleService } from "./run-bundle.service.js";
import { EdgModule } from "../../edg/edg.module.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";
import { ClipReviewModule } from "../review/clip-review.module.js";

/**
 * "Download all" (2026-10-01): a run's clips, every shape, as one streamed ZIP.
 * And "For your editing app" (2026-10-01): one clip's clean cut with FCPXML,
 * Premiere XML and SRT timelines, delivered the same way.
 */
@Module({
  imports: [WorkspacesModule, ClipReviewModule, EdgModule],
  controllers: [
    RunBundleController,
    PublicRunDownloadController,
    ClipNleDownloadController,
    PublicNleDownloadController,
  ],
  providers: [RunBundleService, ClipNleDownloadService],
})
export class RepurposeBundleModule {}

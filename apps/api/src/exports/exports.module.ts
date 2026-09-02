import { Module } from "@nestjs/common";

import { BrandAssetsController } from "./brand-assets.controller.js";
import { BrandAssetsService } from "./brand-assets.service.js";
import { BrowserManifestDailyCap } from "./daily-cap.js";
import { DefaultWatermarkService } from "./default-watermark.service.js";
import { ExportsController } from "./exports.controller.js";
import { ExportsService } from "./exports.service.js";
import { NINE_PASS_LEDGER, NoopNinePassLedger } from "./nine-pass-ledger.js";
import {
  RenderSubtitleCompletionHandler,
  RenderVideoCompletionHandler,
} from "./render-completion.handler.js";
import { ManifestSignerService } from "../common/crypto/manifest-signer.js";
import { EdgModule } from "../edg/index.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * The export decision engine, the signed render manifest, cloud render/subtitle
 * job producers, the browser-completion callback, downloads, retention and a
 * workspace's brand assets (A21).
 *
 * `JobsModule` for `JobsService.enqueue` and the completion registry the two
 * handlers register themselves with; `EdgModule` for `EdgRepository.projectionOf`
 * and `loadChunks`, the same read path A15/A20 use. `EntitlementService` and
 * `CreditsFacade` come from the global `WorkspacesModule`/`CreditsModule`
 * bindings, exactly as `fonts` and `media` already inject them.
 */
@Module({
  imports: [JobsModule, EdgModule, WorkspacesModule],
  controllers: [ExportsController, BrandAssetsController],
  providers: [
    ExportsService,
    BrandAssetsService,
    ManifestSignerService,
    BrowserManifestDailyCap,
    DefaultWatermarkService,
    RenderVideoCompletionHandler,
    RenderSubtitleCompletionHandler,
    WorkspaceMemberGuard,
    { provide: NINE_PASS_LEDGER, useClass: NoopNinePassLedger },
  ],
  exports: [ExportsService, ManifestSignerService],
})
export class ExportsModule {}

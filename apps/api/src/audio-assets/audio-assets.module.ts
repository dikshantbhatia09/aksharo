import { Module } from "@nestjs/common";

import { AudioAssetsController } from "./audio-assets.controller.js";
import { AudioAssetsRepository } from "./audio-assets.repository.js";
import { AudioAssetsService } from "./audio-assets.service.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * D04a: the SFX/music catalogue read path (`AudioAssetsRepository`,
 * `assetAllowed`) that `PassesModule`'s sfx producer and the completion
 * handler depend on. D04d adds the one HTTP surface this module owns:
 * `GET /audio-assets/{assetId}/url` (`AudioAssetsController` /
 * `AudioAssetsService`) — ingestion is still the CLI
 * (`scripts/ingest-audio-pack.ts`), never HTTP. `WorkspacesModule` is
 * imported for `WorkspaceMemberGuard` (`fonts.module.ts`'s same reason);
 * `DERIVED_STORE` needs no import because `StorageModule` is `@Global()`.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [AudioAssetsController],
  providers: [AudioAssetsRepository, AudioAssetsService],
  exports: [AudioAssetsRepository],
})
export class AudioAssetsModule {}

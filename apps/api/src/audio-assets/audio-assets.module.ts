import { Module } from "@nestjs/common";

import { AudioAssetsRepository } from "./audio-assets.repository.js";

/**
 * D04a: the SFX/music catalogue read path (`AudioAssetsRepository`,
 * `assetAllowed`) that `PassesModule`'s sfx producer and the completion
 * handler depend on. No controller of its own yet — ingestion is the CLI
 * (`scripts/ingest-audio-pack.ts`), not an HTTP surface.
 */
@Module({
  providers: [AudioAssetsRepository],
  exports: [AudioAssetsRepository],
})
export class AudioAssetsModule {}

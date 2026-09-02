import { Module } from "@nestjs/common";

import { ApiKeysController } from "./keys/api-keys.controller.js";
import { ApiKeysService } from "./keys/api-keys.service.js";
import { ApiKeyRateLimitGuard } from "./v1/api-key-rate-limit.guard.js";
import { IdempotencyService } from "./v1/idempotency.service.js";
import { SourceUrlIngestService } from "./v1/source-url-ingest.service.js";
import { V1ExportsController } from "./v1/v1-exports.controller.js";
import { V1JobsController } from "./v1/v1-jobs.controller.js";
import { V1ProjectsController } from "./v1/v1-projects.controller.js";
import { V1TranscriptsController } from "./v1/v1-transcripts.controller.js";
import { ExportsModule } from "../exports/exports.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { TranscriptsModule } from "../transcripts/transcripts.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * B14: API key issuance (`Settings → Developers`) and the `/v1` public API
 * surface. Imports the feature modules whose services `/v1` wraps
 * (`ProjectsModule`, `TranscriptsModule`, `ExportsModule`, `JobsModule`)
 * rather than reimplementing any of them. `RAW_STORE` (for
 * `SourceUrlIngestService`) needs no import here: `StorageModule` is `@Global()`
 * via `CommonModule`.
 */
@Module({
  imports: [ProjectsModule, TranscriptsModule, ExportsModule, JobsModule, WorkspacesModule],
  controllers: [
    ApiKeysController,
    V1ProjectsController,
    V1TranscriptsController,
    V1ExportsController,
    V1JobsController,
  ],
  providers: [ApiKeysService, ApiKeyRateLimitGuard, IdempotencyService, SourceUrlIngestService],
  exports: [ApiKeysService],
})
export class PublicApiModule {}

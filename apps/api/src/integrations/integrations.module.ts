import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { CloudImportService } from "./cloud-import.service.js";
import { CloudIntegrationService } from "./cloud-integration.service.js";
import { IntegrationsController } from "./integrations.controller.js";
import { VaultService } from "./vault.service.js";
import { ZoomController } from "./zoom.controller.js";
import { ZoomIngestService } from "./zoom-ingest.service.js";
import { ZoomService } from "./zoom.service.js";
import { ZoomWebhookController } from "../webhooks/zoom.controller.js";

@Module({
  imports: [CommonModule, ProjectsModule, JobsModule, WorkspacesModule],
  controllers: [IntegrationsController, ZoomController, ZoomWebhookController],
  providers: [
    VaultService,
    CloudIntegrationService,
    CloudImportService,
    ZoomService,
    ZoomIngestService,
  ],
  exports: [
    VaultService,
    CloudIntegrationService,
    CloudImportService,
    ZoomService,
    ZoomIngestService,
  ],
})
export class IntegrationsModule {}


import { Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { ProjectsModule } from "../projects/projects.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";
import { CloudImportService } from "./cloud-import.service.js";
import { CloudIntegrationService } from "./cloud-integration.service.js";
import { IntegrationsController } from "./integrations.controller.js";
import { VaultService } from "./vault.service.js";

@Module({
  imports: [CommonModule, ProjectsModule, JobsModule, WorkspacesModule],
  controllers: [IntegrationsController],
  providers: [VaultService, CloudIntegrationService, CloudImportService],
  exports: [VaultService, CloudIntegrationService, CloudImportService],
})
export class IntegrationsModule {}


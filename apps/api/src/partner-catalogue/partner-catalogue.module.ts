import { Module } from "@nestjs/common";

import { InternalPartnerGrantController } from "./internal-partner-grant.controller.js";
import { PartnerCatalogueController } from "./partner-catalogue.controller.js";
import { PartnerCatalogueService } from "./partner-catalogue.service.js";
import { InternalSignatureGuard } from "../internal/internal-signature.guard.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * D04b: `PartnerCatalogueService` — the flag-gated interface over
 * `MockPartnerCatalogue`/`EpidemicPartnerCatalogue` and the
 * `asset_clearance_grants` grant lifecycle.
 *
 * D04b2 adds the HTTP surface (`PartnerCatalogueController`):
 * `GET /partner-catalogue/search`, `POST /partner-catalogue/grants`,
 * `DELETE /partner-catalogue/grants/{id}` — every route 404s while
 * `assets.partnerCatalogue` is off. `WorkspacesModule` is imported for
 * `WorkspaceMemberGuard` (`audio-assets.module.ts`'s same reason);
 * `CommonAuditService` needs no import because `AuditModule` is `@Global()`.
 * `PartnerCatalogueService` stays exported so
 * `scheduler/tasks/partner-*.task.ts`, the export-completion handler and
 * `apps/render`'s grant-check caller can inject it directly.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [PartnerCatalogueController, InternalPartnerGrantController],
  providers: [PartnerCatalogueService, InternalSignatureGuard],
  exports: [PartnerCatalogueService],
})
export class PartnerCatalogueModule {}

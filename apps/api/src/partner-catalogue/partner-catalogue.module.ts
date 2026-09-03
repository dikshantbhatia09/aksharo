import { Module } from "@nestjs/common";

import { PartnerCatalogueService } from "./partner-catalogue.service.js";

/**
 * D04b: `PartnerCatalogueService` — the flag-gated interface over
 * `MockPartnerCatalogue`/`EpidemicPartnerCatalogue` and the
 * `asset_clearance_grants` grant lifecycle. No controller yet (the brief's
 * HTTP surface for search/grant/revoke is not named as a numbered acceptance
 * criterion and stays a follow-up; see the final report). Exported so
 * `scheduler/tasks/partner-*.task.ts` and a later admin/render caller can
 * inject it without importing this module's internals directly.
 */
@Module({
  providers: [PartnerCatalogueService],
  exports: [PartnerCatalogueService],
})
export class PartnerCatalogueModule {}

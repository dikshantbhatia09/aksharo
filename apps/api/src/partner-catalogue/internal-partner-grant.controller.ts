import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { z } from "zod";

import { PartnerCatalogueService } from "./partner-catalogue.service.js";
import { zodDto } from "../common/index.js";
import { InternalSignatureGuard } from "../internal/internal-signature.guard.js";

const verifyPartnerGrantSchema = z.object({
  workspaceId: z.string().min(1),
  providerAssetId: z.string().min(1),
});
class VerifyPartnerGrantDto extends zodDto(verifyPartnerGrantSchema) {}

/**
 * `POST /internal/partner-catalogue/verify-grant` (D04b2 scope §4) —
 * `apps/render`'s pre-download check, guarded by
 * {@link InternalSignatureGuard} exactly like `InternalMediaController` and
 * `InternalJobsController` (`internal/internal.module.ts`). Lives beside
 * the rest of `partner-catalogue/` rather than in `internal/` itself: this
 * work package's file boundary does not include `apps/api/src/internal/**`,
 * and `InternalSignatureGuard` is a plain importable provider — nothing
 * about it requires the route to be registered from that module.
 *
 * Always 200s with `{ allowed: boolean }`, never a 403/404 — a worker
 * distinguishing "no such grant" from "not authorised to ask" learns
 * nothing useful, and a uniform reply keeps the guard's own "every failure
 * looks the same" posture (`internal-signature.guard.ts`) one layer up too.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/partner-catalogue")
export class InternalPartnerGrantController {
  constructor(private readonly catalogue: PartnerCatalogueService) {}

  @Post("verify-grant")
  @HttpCode(HttpStatus.OK)
  async verifyGrant(@Body() body: VerifyPartnerGrantDto): Promise<{ allowed: boolean }> {
    const allowed = await this.catalogue.verifyActiveGrant({
      workspaceId: body.workspaceId,
      providerAssetId: body.providerAssetId,
    });
    return { allowed };
  }
}

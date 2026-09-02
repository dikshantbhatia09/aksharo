import { Body, Controller, Delete, Get, Param, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { UpsertTaxRegistrationSchema } from "./tax-registrations.dto.js";
import { TaxRegistrationsService } from "./tax-registrations.service.js";
import { AdminGuard } from "../../admin/admin.guard.js";

/**
 * `/admin/tax-registrations` (brief §6): GSTIN and LUT rows, admin-editable.
 *
 * Behind {@link AdminGuard} — platform staff only, not scoped to a workspace,
 * exactly like `/admin/dlq` (THREAT-MODEL T20). There is deliberately no
 * "register with the GST portal" action: filing GST/LUT is an offline,
 * human act (D41/RR-05 D7/E2); this only records what has already been filed.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@UseGuards(AdminGuard)
@Controller("admin/tax-registrations")
export class TaxRegistrationsController {
  constructor(private readonly registrations: TaxRegistrationsService) {}

  @Get()
  @ApiOperation({ summary: "List every tax registration (GSTIN, LUT) on file." })
  @ApiOkResponse()
  async list() {
    return this.registrations.list();
  }

  @Put()
  @ApiOperation({
    summary: "Create or update a tax registration (upsert on jurisdiction+taxIdType+taxId).",
  })
  @ApiOkResponse()
  async upsert(@Body() body: unknown) {
    const parsed = UpsertTaxRegistrationSchema.parse(body);
    return this.registrations.upsert(parsed);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove a tax registration row." })
  @ApiOkResponse()
  async remove(@Param("id") id: string) {
    await this.registrations.delete(id);
    return { deleted: true };
  }
}

import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { AdminGuard } from "../admin.guard.js";

export interface AdminSupportStatus {
  readonly available: boolean;
  readonly message: string;
}

/**
 * B13 scope §2: "support tickets (B12) with replies via the notify
 * interface". Stubbed behind B12's absence, per the orchestrator addendum:
 * `apps/api/src/support/**` did not exist on \`main\` when this WP merged it
 * (checked at the time of B13d's commit — B12 may have landed since; if
 * \`src/support/**\` exists now, this stub should be replaced with a real
 * panel consuming B12's ticket service/module rather than reimplementing a
 * data model B12 owns).
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/support")
export class AdminSupportController {
  @Get("status")
  @ApiOperation({
    summary: "Whether the support-ticket panel has a real backend yet (B12)",
    operationId: "adminSupportStatus",
  })
  @ApiOkResponse({
    schema: { properties: { available: { type: "boolean" }, message: { type: "string" } } },
  })
  status(): AdminSupportStatus {
    return {
      available: false,
      message:
        "B12's support-ticket module has not merged yet. This panel is a stub — " +
        'see B13\'s final report, "open questions".',
    };
  }
}

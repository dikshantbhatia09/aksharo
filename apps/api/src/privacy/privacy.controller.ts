import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { PRIVACY_NOTICE } from "./privacy-notice.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { JwtAuthGuard, Public } from "../common/guards/index.js";

import type { PrivacyNotice } from "./privacy-notice.js";

const noticeSchema = z.object({
  version: z.string(),
  effectiveFrom: z.string(),
  url: z.string(),
  contactEmail: z.string(),
  responseDays: z.number().int(),
  rights: z.array(z.string()),
  purposes: z.array(
    z.object({
      purpose: z.string(),
      title: z.string(),
      summary: z.string(),
      essential: z.boolean(),
      defaultGranted: z.boolean(),
    }),
  ),
});

/**
 * The published privacy surface (D61, 07 §Privacy & rights).
 *
 * The notice is public because a person has to be able to read it **before**
 * creating an account — a notice you must sign in to see is not a notice.
 *
 * The parental-consent waiting list is not here: it belongs to nobody's
 * workspace, so it sits behind `AdminGuard` in `AdminModule`
 * (`GET /admin/parental-waitlist`), where A08b keeps every route that crosses a
 * tenant boundary.
 */
@ApiTags("privacy")
@Controller("privacy")
@UseGuards(JwtAuthGuard)
export class PrivacyController {
  @Get("notice")
  @Public()
  @ApiOperation({
    summary: "The current itemised privacy notice",
    description:
      "Version metadata and the purpose list a consent form renders (DPDP Rule 3). " +
      "`version` is the string stamped onto every `consent_records` row; the prose " +
      "moves to the content module when it ships.",
    operationId: "getPrivacyNotice",
  })
  @ApiOkResponse(zodResponse(noticeSchema, "The current notice."))
  notice(): PrivacyNotice {
    return PRIVACY_NOTICE;
  }
}

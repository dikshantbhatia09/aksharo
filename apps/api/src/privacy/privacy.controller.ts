import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";

import { ParentalWaitlistService } from "./parental-waitlist.service.js";
import { PLATFORM_ADMINS_FLAG, PlatformAdminGuard } from "./platform-admin.guard.js";
import { PRIVACY_NOTICE } from "./privacy-notice.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { JwtAuthGuard, Public } from "../common/guards/index.js";
import { zodDto } from "../common/index.js";

import type { WaitlistPage } from "./parental-waitlist.service.js";
import type { PrivacyNotice } from "./privacy-notice.js";

const listWaitlistQuery = z.object({
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

class ListWaitlistQueryDto extends zodDto(listWaitlistQuery) {}

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

const waitlistPageSchema = z.object({
  total: z.number().int(),
  nextCursor: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.string(),
      emailHash: z.string(),
      jurisdiction: z.enum(["IN", "EU", "OTHER"]),
      ageBracket: z.enum(["adult", "minor"]),
      createdAt: z.string(),
      notifiedAt: z.string().nullable(),
    }),
  ),
});

/**
 * The published privacy surface (D61, 07 §Privacy & rights).
 *
 * The notice is public because a person has to be able to read it **before**
 * creating an account — a notice you must sign in to see is not a notice.
 */
@ApiTags("privacy")
@Controller("privacy")
@UseGuards(JwtAuthGuard)
export class PrivacyController {
  constructor(private readonly waitlist: ParentalWaitlistService) {}

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

  @Get("parental-waitlist")
  @UseGuards(PlatformAdminGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "The parental-consent waiting list (platform administrators)",
    description:
      "Addresses are stored only as a SHA-256 digest, so this answers how many " +
      "people are waiting and since when, not who they are. Authorised from the " +
      `\`${PLATFORM_ADMINS_FLAG}\` entry of FEATURE_FLAGS_JSON until B13 ships the ` +
      "admin application; nobody is an administrator by default.",
    operationId: "listParentalWaitlist",
  })
  @ApiOkResponse(zodResponse(waitlistPageSchema, "One page of the waiting list, oldest first."))
  @ApiForbiddenResponse({ description: "`common/forbidden` — not a platform administrator." })
  async parentalWaitlist(@Query() query: ListWaitlistQueryDto): Promise<WaitlistPage> {
    return this.waitlist.list(query);
  }
}

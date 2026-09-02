import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { z } from "zod";

import { AdminGuard } from "./admin.guard.js";
import { zodResponse } from "../auth/dto/openapi.js";
import { zodDto } from "../common/index.js";
import { ParentalWaitlistService } from "../privacy/parental-waitlist.service.js";

import type { WaitlistPage } from "../privacy/parental-waitlist.service.js";

const listWaitlistQuery = z.object({
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

class ListWaitlistQueryDto extends zodDto(listWaitlistQuery) {}

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
 * The parental-consent waiting list, for platform staff (A05, D60).
 *
 * It lives under `/admin` rather than beside the rest of the privacy surface for
 * the reason `AdminModule` exists: the list belongs to nobody's workspace, so
 * there is no membership that could authorise reading it, and A08b's rule is that
 * every route crossing a tenant boundary sits behind {@link AdminGuard} in this
 * module — where it cannot be added without one.
 *
 * Read-only, and it reveals nothing about anybody: only `sha256(address)` is
 * stored, so this answers how many people are waiting, in which jurisdictions and
 * since when. When the parental-consent flow ships (before May 2027) the mailer
 * matches an address a person types back to a row by hashing it.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/parental-waitlist")
export class AdminParentalWaitlistController {
  constructor(private readonly waitlist: ParentalWaitlistService) {}

  @Get()
  @ApiOperation({
    summary: "The parental-consent waiting list, oldest first",
    description:
      "Addresses are stored only as a SHA-256 digest, so this reports how many " +
      "people are waiting and since when, never who they are. Cursor pagination: " +
      "pass the previous page's `nextCursor`.",
    operationId: "listParentalWaitlist",
  })
  @ApiOkResponse(zodResponse(waitlistPageSchema, "One page of the waiting list, oldest first."))
  async list(@Query() query: ListWaitlistQueryDto): Promise<WaitlistPage> {
    return this.waitlist.list(query);
  }
}

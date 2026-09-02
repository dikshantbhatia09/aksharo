import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { PRIVACY_NOTICE } from "./privacy-notice.js";
import subProcessorsContent from "../../content/sub-processors.json";
import { zodResponse } from "../auth/dto/openapi.js";
import { JwtAuthGuard, Public } from "../common/guards/index.js";

import type { PrivacyNotice } from "./privacy-notice.js";

const subProcessorSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  region: z.string(),
  dpaDate: z.string(),
});
const subProcessorsSchema = z.object({
  version: z.string(),
  processors: z.array(subProcessorSchema),
});

export interface SubProcessorList {
  readonly version: string;
  readonly processors: readonly {
    readonly name: string;
    readonly purpose: string;
    readonly region: string;
    readonly dpaDate: string;
  }[];
}

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

  @Get("sub-processors")
  @Public()
  @ApiOperation({
    summary: "The third parties personal data is shared with",
    description:
      "Static, maintained by hand in `apps/api/content/sub-processors.json` " +
      "(D61 Rule 3's itemised-notice obligation extends to naming processors). " +
      "Public for the same reason the notice is: a person deciding whether to " +
      "sign up has to be able to read it first.",
    operationId: "getSubProcessors",
  })
  @ApiOkResponse(zodResponse(subProcessorsSchema, "The current sub-processor list."))
  subProcessors(): SubProcessorList {
    return subProcessorsContent;
  }
}

import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ExampleRunService } from "./example-run.service.js";
import {
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../../common/guards/index.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";
import { RepurposeService } from "../repurpose.service.js";

import type { ExampleRunResponse } from "./example-run.service.js";
import type { RateLimitRule } from "../../common/guards/index.js";

/**
 * Opening the example is a page view: a person clicks around it a few times a
 * minute at most. The answer is cached, so this bounds a script, not a person.
 */
export const EXAMPLE_RATE_LIMIT = {
  name: "repurpose:example:user",
  by: "user",
  capacity: 30,
  refillPerSec: 0.5,
} as const satisfies RateLimitRule;

/**
 * `GET /repurpose/example` (2026-10-01, OpusClip's "try a sample project"):
 * the finished run the owner chose (`DEMO_RUN_ID`), read only, for any
 * signed-in person whatever their workspace (`ExampleRunService` says what is
 * and is not in it). `{available: false}` while none is set, which is how it
 * ships.
 *
 * The guard chain is every repurpose route's, with `viewer`, because it
 * checks the CALLER: signed in, a member of the workspace their token names,
 * and with the clips surface on for it (404 otherwise, like every route of
 * the surface). Nothing about the example run's own workspace is checked
 * against the caller - showing it to everyone is the point.
 *
 * There is no other route: nothing about the example can be changed, renamed,
 * picked for a download, searched by meaning or opened in the editor.
 * `no-store`, so no cache between here and the page keeps a signed URL.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/example")
export class RepurposeExampleController {
  constructor(
    private readonly example: ExampleRunService,
    private readonly runs: RepurposeService,
  ) {}

  @Get()
  @Roles("viewer")
  @UseGuards(RateLimitGuard)
  @RateLimit(EXAMPLE_RATE_LIMIT)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "A finished example run, read only",
    description:
      "`{available: false}` when no example is set. Otherwise the run's title, its finished " +
      "clips (each size's captioned video and its images, signed for an hour), their moments " +
      "and scores, and each clip's words. The same for every signed-in person; nothing of the " +
      "workspace it came from.",
    operationId: "getRepurposeExample",
  })
  async get(@CurrentWorkspace() workspaceId: string): Promise<ExampleRunResponse> {
    await this.runs.assertAvailable(workspaceId);
    return this.example.view();
  }
}

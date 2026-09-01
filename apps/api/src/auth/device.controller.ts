import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { RATE_LIMITS } from "./auth.constants.js";
import { DeviceCodeService } from "./device-code.service.js";
import {
  DeviceApproveDto,
  DeviceCodeRequestDto,
  DeviceTokenDto,
  deviceApproveSchema,
  deviceCodeRequestSchema,
  deviceCodeResponseSchema,
  deviceTokenSchema,
  pendingApprovalSchema,
  tokenResponseSchema,
} from "./dto/auth.dto.js";
import { zodBody, zodResponse } from "./dto/openapi.js";
import { resolveCoarseLocation } from "./geo.js";
import { normaliseUserCode } from "./tokens.js";
import {
  clientIp,
  clientUserAgent,
  CurrentUser,
  JwtAuthGuard,
  Public,
  RateLimit,
  RateLimitGuard,
} from "../common/guards/index.js";
import { AppException, ERROR_CODES } from "../common/index.js";

import type { DeviceCodeGrant, PendingApproval } from "./device-code.service.js";
import type { CoarseLocation } from "./geo.js";
import type { IssuedTokens } from "./session.service.js";
import type { AuthPrincipal } from "../common/guards/index.js";
import type { Request } from "express";

/**
 * The device grant (RFC 8628 shape), for clients with no browser of their own:
 * the desktop app, the local bridge and the host-application panels.
 *
 * `code` and `token` are public -- the device has no credentials yet. `approve`
 * and the lookup are not: THREAT-MODEL T3 requires an authenticated web session to
 * approve, which is what stops a phished code from being approved by the attacker
 * who started the flow.
 */
@ApiTags("auth")
@Controller("auth/device")
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class DeviceController {
  constructor(private readonly devices: DeviceCodeService) {}

  @Post("code")
  @Public()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(RATE_LIMITS.deviceCodeIp)
  @ApiOperation({
    summary: "Start a device sign-in",
    description:
      "Returns an 8-character user code from an alphabet with no ambiguous glyphs, a " +
      "10-minute expiry and a 5-second polling interval. At most five flows may be in " +
      "flight from one address.",
  })
  @ApiBody(zodBody(deviceCodeRequestSchema))
  @ApiCreatedResponse(zodResponse(deviceCodeResponseSchema, "A device code and a user code."))
  request(@Body() body: DeviceCodeRequestDto, @Req() request: Request): Promise<DeviceCodeGrant> {
    const ua = clientUserAgent(request);
    return this.devices.request({
      clientKind: body.clientKind,
      ...(body.hostApp === undefined ? {} : { hostApp: body.hostApp }),
      deviceInfo: { ...(body.deviceInfo ?? {}), ...(ua === undefined ? {} : { userAgent: ua }) },
      ip: clientIp(request),
      ...locationOf(request),
    });
  }

  @Post("token")
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.deviceTokenIp)
  @ApiOperation({
    summary: "Poll for the result",
    description:
      "400 with `auth/authorization_pending` until the code is approved, " +
      "`auth/slow_down` when polled faster than the interval, `auth/expired_token` " +
      "after 10 minutes and `auth/access_denied` when the user declines.",
  })
  @ApiBody(zodBody(deviceTokenSchema))
  @ApiOkResponse(zodResponse(tokenResponseSchema, "Access and refresh tokens."))
  @ApiBadRequestResponse({
    description:
      "auth/authorization_pending, auth/slow_down, auth/expired_token, auth/access_denied",
  })
  poll(@Body() body: DeviceTokenDto, @Req() request: Request): Promise<IssuedTokens> {
    return this.devices.poll(body.deviceCode, { ip: clientIp(request) });
  }

  @Get("code/:userCode")
  @ApiOperation({
    summary: "What is asking for approval",
    description:
      "The approval screen's data: host application, device facts, address and a coarse " +
      "location, so a user can tell a device on their desk from one on somebody else's.",
  })
  @ApiOkResponse(zodResponse(pendingApprovalSchema, "The pending request."))
  describe(@Param("userCode") userCode: string): Promise<PendingApproval> {
    return this.devices.describe(requireUserCode(userCode));
  }

  @Post("approve")
  @HttpCode(HttpStatus.OK)
  @RateLimit(RATE_LIMITS.deviceApproveUser)
  @ApiOperation({
    summary: "Approve or decline a device sign-in",
    description:
      "`workspaceId` defaults to the workspace of the approving session and is always " +
      "re-checked against memberships.",
  })
  @ApiBody(zodBody(deviceApproveSchema))
  @ApiOkResponse({ description: "approved or denied" })
  decide(
    @Body() body: DeviceApproveDto,
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<{ status: "approved" | "denied" }> {
    return this.devices.decide({
      userCode: requireUserCode(body.userCode),
      approverId: principal.userId,
      workspaceId: body.workspaceId ?? principal.workspaceId,
      approve: (body.decision ?? "approve") === "approve",
      ip: clientIp(request),
    });
  }
}

/** Reject a malformed code the same way an unknown one is rejected. */
function requireUserCode(input: string): string {
  const normalised = normaliseUserCode(input);
  if (normalised === undefined) {
    throw new AppException(
      ERROR_CODES.notFound,
      "That code is not waiting for approval.",
      HttpStatus.NOT_FOUND,
    );
  }
  return normalised;
}

/** The CDN's view of where the device is, when there is one. */
function locationOf(request: Request): { location?: CoarseLocation } {
  const location = resolveCoarseLocation(request.headers);
  return location === undefined ? {} : { location };
}

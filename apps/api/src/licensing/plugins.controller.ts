import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ActivateDto, activateSchema, HeartbeatDto, heartbeatSchema } from "./licensing.dto.js";
import { type ActivateResult, type HeartbeatResult, PluginsService } from "./plugins.service.js";
import { zodBody } from "../auth/dto/openapi.js";
import { Public } from "../common/guards/index.js";

/**
 * `POST /plugins/activate`, `POST /plugins/heartbeat`, `GET
 * /plugins/revocation-snapshot` (brief section 3, 07 section Plugins). Public:
 * these are how a plugin or the desktop app *gets* credentials in the first
 * place (a licence key or a device code), so nothing here can require a
 * bearer token -- the licence key or device code IS the credential (07 section
 * Conventions: "X-License-Key (plugins, offline fallback)").
 */
@ApiTags("plugins")
@Controller("plugins")
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Post("activate")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Activate a device with a licence key or a device code",
    description:
      "Exactly one of licenseKey or deviceCode. Returns a devices row and a " +
      "signed licenseSnapshot verifiable offline for 7 days.",
    operationId: "activatePlugin",
  })
  @ApiBody(zodBody(activateSchema))
  @ApiOkResponse({ description: "Device registered; licence snapshot issued." })
  async activate(@Body() body: ActivateDto): Promise<ActivateResult> {
    return this.plugins.activate(body);
  }

  @Post("heartbeat")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Renew the 7-day entitlement lease",
    description: "Returns the current revocationSerial and a refreshed licenseSnapshot.",
    operationId: "pluginHeartbeat",
  })
  @ApiBody(zodBody(heartbeatSchema))
  @ApiOkResponse({ description: "Lease renewed." })
  async heartbeat(@Body() body: HeartbeatDto): Promise<HeartbeatResult> {
    return this.plugins.heartbeat(body);
  }

  @Get("revocation-snapshot")
  @Public()
  @ApiOperation({
    summary: "Signed daily revocation snapshot for fully offline clients",
    operationId: "pluginRevocationSnapshot",
  })
  @ApiOkResponse({ description: "A signed, compact snapshot token." })
  async revocationSnapshot(): Promise<{ snapshot: string }> {
    return { snapshot: await this.plugins.revocationSnapshot() };
  }
}

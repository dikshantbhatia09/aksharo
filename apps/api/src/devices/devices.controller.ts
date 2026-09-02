import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import {
  deviceViewSchema,
  RegisterDeviceDto,
  registerDeviceSchema,
  RenameDeviceDto,
  renameDeviceSchema,
} from "./devices.dto.js";
import { type DeviceView, DevicesService } from "./devices.service.js";
import { zodArrayResponse, zodBody, zodResponse } from "../auth/dto/openapi.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { PrismaService } from "../common/index.js";
import { context } from "../users/users.controller.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { Device } from "@prisma/client";
import type { Request } from "express";

function toView(device: Device, currentDeviceId: string | null): DeviceView {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    host: device.host,
    hostVersion: device.hostVersion,
    appVersion: device.appVersion,
    lastActiveAt: device.lastActiveAt?.toISOString() ?? null,
    leaseUntil: device.leaseUntil?.toISOString() ?? null,
    revokedAt: device.revokedAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
    isCurrentSession: device.id === currentDeviceId,
  };
}

/**
 * `/devices` (07 §Workspaces): no `:id` in the path — scoped to the caller's
 * workspace through the access token, exactly like `/billing/*`
 * (`WorkspaceMemberGuard` re-checks membership against the `ws` claim).
 */
@ApiTags("devices")
@Controller("devices")
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "This workspace's registered devices", operationId: "listDevices" })
  @ApiOkResponse(zodArrayResponse(deviceViewSchema, "Devices, revoked ones last."))
  async list(@CurrentUser() principal: AuthPrincipal): Promise<DeviceView[]> {
    const currentDeviceId = await this.currentDeviceId(principal.jti);
    return this.devices.list(principal.workspaceId, currentDeviceId);
  }

  @Post("register")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Register (or refresh) this device",
    description:
      "Same fingerprint refreshes the 7-day lease without counting twice " +
      "against the plan's device limit; a genuinely new device beyond the " +
      "limit is refused with `devices/limit_reached` and the revocable list.",
    operationId: "registerDevice",
  })
  @ApiBody(zodBody(registerDeviceSchema))
  @ApiOkResponse(zodResponse(deviceViewSchema, "The registered device."))
  @ApiConflictResponse({ description: "`devices/limit_reached`." })
  async register(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: RegisterDeviceDto,
    @Req() request: Request,
  ): Promise<DeviceView> {
    const device = await this.devices.register(
      principal.workspaceId,
      principal.userId,
      body,
      context(request),
    );
    await this.prisma.session.update({
      where: { id: principal.jti },
      data: { deviceId: device.id },
    });
    return toView(device, device.id);
  }

  @Patch(":deviceId")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Rename a device", operationId: "renameDevice" })
  @ApiBody(zodBody(renameDeviceSchema))
  @ApiOkResponse(zodResponse(deviceViewSchema, "The renamed device."))
  async rename(
    @Param("deviceId") deviceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: RenameDeviceDto,
    @Req() request: Request,
  ): Promise<DeviceView> {
    const device = await this.devices.rename(
      principal.workspaceId,
      deviceId,
      body.name,
      principal.userId,
      context(request),
    );
    const currentDeviceId = await this.currentDeviceId(principal.jti);
    return toView(device, currentDeviceId);
  }

  @Delete(":deviceId")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @Roles("viewer")
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary: "Revoke a device",
    description: "The next heartbeat against this device's lease/licence fails.",
    operationId: "revokeDevice",
  })
  @ApiOkResponse(zodResponse(deviceViewSchema, "The revoked device."))
  async revoke(
    @Param("deviceId") deviceId: string,
    @CurrentUser() principal: AuthPrincipal,
    @Req() request: Request,
  ): Promise<DeviceView> {
    const device = await this.devices.revoke(
      principal.workspaceId,
      deviceId,
      principal.userId,
      context(request),
    );
    return toView(device, null);
  }

  private async currentDeviceId(sessionId: string): Promise<string | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { deviceId: true },
    });
    return session?.deviceId ?? null;
  }
}

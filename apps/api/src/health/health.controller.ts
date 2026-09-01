import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from "@nestjs/swagger";

import { APP_VERSION } from "../version.js";
import { HealthService } from "./health.service.js";

import type { Response } from "express";

export class HealthResponseDto {
  @ApiProperty({ example: "ok", enum: ["ok"] })
  status!: "ok";

  @ApiProperty({ example: APP_VERSION, description: "Deployed API version." })
  version!: string;
}

export class DependencyCheckDto {
  @ApiProperty({ enum: ["up", "down"] })
  status!: "up" | "down";

  @ApiProperty({ example: 3, description: "Round-trip time for the check." })
  latencyMs!: number;

  @ApiProperty({ required: false, description: "Present only when the check failed." })
  error?: string;
}

export class ReadinessChecksDto {
  @ApiProperty({ type: DependencyCheckDto }) db!: DependencyCheckDto;
  @ApiProperty({ type: DependencyCheckDto }) redis!: DependencyCheckDto;
  @ApiProperty({ type: DependencyCheckDto }) storage!: DependencyCheckDto;
}

export class ReadinessResponseDto {
  @ApiProperty({ enum: ["ok", "degraded"] })
  status!: "ok" | "degraded";

  @ApiProperty({ example: APP_VERSION })
  version!: string;

  @ApiProperty({ type: ReadinessChecksDto })
  checks!: ReadinessChecksDto;
}

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness. Deliberately dependency-free: it answers whether this process is up,
   * so a slow database restarts nothing. The orchestrator's liveness probe points
   * here and its readiness probe points at `/health/ready`.
   */
  @Get()
  @ApiOperation({ summary: "Liveness probe", operationId: "getHealth" })
  @ApiOkResponse({ type: HealthResponseDto })
  getHealth(): HealthResponseDto {
    return { status: "ok", version: APP_VERSION };
  }

  /**
   * Readiness: can this process actually serve traffic?
   *
   * 200 when Postgres, Redis and the object store all answer; 503 with the same
   * body when any of them does not, so a load balancer drains the instance while
   * an operator still gets the detail.
   */
  @Get("ready")
  @ApiOperation({ summary: "Readiness probe (db, redis, storage)", operationId: "getReadiness" })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiResponse({ status: 503, type: ReadinessResponseDto, description: "A dependency is down." })
  async getReadiness(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessResponseDto> {
    const report = await this.health.readiness();
    response.status(report.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: report.status, version: APP_VERSION, checks: report.checks };
  }
}

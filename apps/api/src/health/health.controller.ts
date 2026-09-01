import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";

import { APP_VERSION } from "../version.js";

export class HealthResponseDto {
  @ApiProperty({ example: "ok", enum: ["ok"] })
  status!: "ok";

  @ApiProperty({ example: APP_VERSION, description: "Deployed API version." })
  version!: string;
}

/**
 * Liveness probe. Deliberately dependency-free: it answers whether this process
 * is up, not whether Postgres or Redis are reachable. A03 adds `/health/ready`
 * with real dependency checks so a slow database cannot restart-loop the pod.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  @ApiOperation({ summary: "Liveness probe", operationId: "getHealth" })
  @ApiOkResponse({ type: HealthResponseDto })
  getHealth(): HealthResponseDto {
    return { status: "ok", version: APP_VERSION };
  }
}

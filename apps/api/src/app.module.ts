import { Module } from "@nestjs/common";

import { CommonModule } from "./common/common.module.js";
import { HealthModule } from "./health/health.module.js";

/**
 * Root module of the modular monolith. One feature module per work package
 * (05-system-architecture, section 3): `auth`, `users`, `workspaces`, `projects`,
 * `media`, `transcripts`, `edg`, `jobs`, `exports`, `billing`, `credits`, ...
 *
 * A03 wires `common` (config, logging, Prisma, Redis, validation) and `health`;
 * later work packages append to `imports`.
 */
@Module({
  imports: [CommonModule, HealthModule],
})
export class AppModule {}

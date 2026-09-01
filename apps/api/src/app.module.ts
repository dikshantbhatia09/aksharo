import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module.js";
import { HealthController } from "./health/health.controller.js";

/**
 * Root module of the modular monolith. One feature module per work package
 * (05-system-architecture, section 3): `auth`, `users`, `workspaces`, `projects`,
 * `media`, `transcripts`, `edg`, `jobs`, `exports`, `billing`, `credits`, ...
 *
 * A01 wires only `config` and `health`; later work packages append to `imports`.
 */
@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
})
export class AppModule {}

import { Module } from "@nestjs/common";

import { AuthModule } from "./auth/auth.module.js";
import { CommonModule } from "./common/common.module.js";
import { HealthModule } from "./health/health.module.js";
import { UsersModule } from "./users/users.module.js";

/**
 * Root module of the modular monolith. One feature module per work package
 * (05-system-architecture, section 3): `auth`, `users`, `workspaces`, `projects`,
 * `media`, `transcripts`, `edg`, `jobs`, `exports`, `billing`, `credits`, ...
 *
 * A03 wires `common` (config, logging, Prisma, Redis, validation) and `health`;
 * A04 adds `auth` and the minimal `users` it needs. Later work packages append to
 * `imports`.
 */
@Module({
  imports: [CommonModule, HealthModule, UsersModule, AuthModule],
})
export class AppModule {}

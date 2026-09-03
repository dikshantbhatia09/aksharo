import { Module } from "@nestjs/common";

import { AdminAffiliatesController } from "./admin-affiliates.controller.js";
import { AdminModule } from "../admin.module.js";

/**
 * Its own module for the same reason \`AdminBillingModule\`/\`AdminUsersModule\`
 * are: reads \`PrismaService\`/\`ENV\` directly (both \`@Global()\`) rather than
 * importing \`AffiliatesModule\`, which already imports \`AdminModule\` itself.
 */
@Module({
  imports: [AdminModule],
  controllers: [AdminAffiliatesController],
})
export class AdminAffiliatesModule {}

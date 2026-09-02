import { Module } from "@nestjs/common";

import { AdminReferralsController } from "./admin-referrals.controller.js";
import { ReferralsModule } from "../../referrals/referrals.module.js";
import { AdminModule } from "../admin.module.js";

/** Its own module for the same reason `AdminBillingModule`/`AdminUsersModule` are. */
@Module({
  imports: [AdminModule, ReferralsModule],
  controllers: [AdminReferralsController],
})
export class AdminReferralsModule {}

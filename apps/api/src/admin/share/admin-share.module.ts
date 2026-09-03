import { Module } from "@nestjs/common";

import { AdminShareController } from "./admin-share.controller.js";
import { ShareModule } from "../../share/share.module.js";
import { AdminModule } from "../admin.module.js";

/** `NotifyService` is global (`NotifyModule`), so it needs no import here. */
@Module({
  imports: [AdminModule, ShareModule],
  controllers: [AdminShareController],
})
export class AdminShareModule {}

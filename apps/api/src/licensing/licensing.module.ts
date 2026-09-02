import { Module } from "@nestjs/common";

import { LicenseKeysController } from "./license-keys.controller.js";
import { LicenseKeysService } from "./license-keys.service.js";
import { PluginsController } from "./plugins.controller.js";
import { PluginsService } from "./plugins.service.js";
import { SigningService } from "./signing.service.js";
import { DevicesModule } from "../devices/devices.module.js";
import { UsersModule } from "../users/users.module.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * Licence keys and the plugin activation/heartbeat surface (brief section 3,
 * 05 section 8, THREAT-MODEL T15). `DeviceCodeService` and `TokenService`
 * (used by `PluginsService`'s device-code activation branch) need no import
 * here: `AuthModule` is `@Global()` and now exports both.
 */
@Module({
  imports: [WorkspacesModule, DevicesModule, UsersModule],
  controllers: [LicenseKeysController, PluginsController],
  providers: [LicenseKeysService, PluginsService, SigningService],
  exports: [LicenseKeysService, SigningService],
})
export class LicensingModule {}

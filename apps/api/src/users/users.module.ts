import { Module } from "@nestjs/common";

import { UsersService } from "./users.service.js";

/**
 * The minimal users surface A04 needs: create an account with its personal
 * workspace, look one up, and answer membership questions. A05 adds the profile,
 * workspace and invitation endpoints and the controller that goes with them.
 */
@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

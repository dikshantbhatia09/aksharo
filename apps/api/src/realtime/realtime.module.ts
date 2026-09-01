import { Global, Module } from "@nestjs/common";

import { AccessTokenGuard } from "./auth/access-token.guard.js";
import { AccessTokenService } from "./auth/access-token.service.js";
import { REALTIME_BUS, RedisRealtimeBus } from "./realtime.bus.js";
import { RealtimeGateway } from "./realtime.gateway.js";
import { RealtimePublisher } from "./realtime.publisher.js";
import { RoomAccessService } from "./room-access.service.js";

/**
 * The `/realtime` WebSocket gateway and the publisher every other module uses.
 *
 * `@Global()` so a feature module can inject `RealtimePublisher` without importing
 * anything, exactly as it injects `PrismaService`.
 *
 * `REALTIME_BUS` is bound to Redis here and to an in-memory broker in tests, which
 * is what lets the fan-out be exercised with two gateway instances in one process.
 */
@Global()
@Module({
  providers: [
    AccessTokenService,
    AccessTokenGuard,
    RoomAccessService,
    RedisRealtimeBus,
    { provide: REALTIME_BUS, useExisting: RedisRealtimeBus },
    RealtimeGateway,
    RealtimePublisher,
  ],
  exports: [AccessTokenService, AccessTokenGuard, RealtimePublisher, RealtimeGateway, REALTIME_BUS],
})
export class RealtimeModule {}

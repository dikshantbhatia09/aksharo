import { Global, Module } from "@nestjs/common";

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
 *
 * A08's interim HTTP guard is gone (A06): every HTTP route now wears A04's
 * `JwtAuthGuard`. `AccessTokenService` stays, because a WebSocket handshake is not
 * a Nest route and the gateway has to verify the token itself.
 */
@Global()
@Module({
  providers: [
    AccessTokenService,
    RoomAccessService,
    RedisRealtimeBus,
    { provide: REALTIME_BUS, useExisting: RedisRealtimeBus },
    RealtimeGateway,
    RealtimePublisher,
  ],
  exports: [AccessTokenService, RealtimePublisher, RealtimeGateway, REALTIME_BUS],
})
export class RealtimeModule {}

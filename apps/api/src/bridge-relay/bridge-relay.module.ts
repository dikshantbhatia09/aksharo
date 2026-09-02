import { Module } from "@nestjs/common";

import { BridgeRelayGateway } from "./bridge-relay.gateway.js";

/**
 * `/bridge/relay` (C01 brief §6). Depends on `RealtimeModule`'s
 * `AccessTokenService` (that module is `@Global()`, so it needs no explicit
 * import here) and `CommonModule`'s `PrismaService`, both already available
 * process-wide by the time `AppModule` reaches this import.
 */
@Module({
  providers: [BridgeRelayGateway],
  exports: [BridgeRelayGateway],
})
export class BridgeRelayModule {}

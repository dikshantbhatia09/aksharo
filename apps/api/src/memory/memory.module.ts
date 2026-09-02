import { Module } from "@nestjs/common";

import { MemoryController } from "./memory.controller.js";
import { MemoryService } from "./memory.service.js";

/**
 * `/memory` (F-204, D62). `MemoryService` also listens for
 * `consent.withdrawn` (`consent-events.ts`) to erase entries on withdrawal —
 * no import of `ConsentsModule` is needed for that, since `EventEmitter2` is
 * global and the listener is a plain `@OnEvent` method.
 */
@Module({
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}

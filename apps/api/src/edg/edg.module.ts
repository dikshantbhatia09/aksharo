import { Module } from "@nestjs/common";

import { EdgInternalController } from "./edg-internal.controller.js";
import { EdgController } from "./edg.controller.js";
import { EdgRateLimiter } from "./edg.rate-limit.js";
import { EdgRepository } from "./edg.repository.js";
import { EdgService } from "./edg.service.js";
import { InternalSignatureGuard } from "../internal/internal-signature.guard.js";

/**
 * The EDG: the hot document, its segments and passes, the `/edg/ops` write path
 * with server-side rebase and compare-and-swap, revisions, snapshots and restore.
 *
 * Nothing is imported. `PrismaService`, `RateLimitService`, `RealtimePublisher`
 * and `ENV` all come from global modules, exactly as `JobsModule` gets them; the
 * only cross-module type is {@link InternalSignatureGuard}, which is provided here
 * rather than imported from `InternalModule` so registering this module cannot
 * pull the whole worker callback surface in behind it.
 *
 * `EdgService` is exported because A11 calls `initialise(projectId, transcript)`
 * the moment a transcript is segmented, and A15/A20 read the document through it.
 * `apps/api/src/edg/init/` is A11's to create.
 */
@Module({
  controllers: [EdgController, EdgInternalController],
  providers: [EdgRepository, EdgRateLimiter, EdgService, InternalSignatureGuard],
  exports: [EdgService, EdgRepository],
})
export class EdgModule {}

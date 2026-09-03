import { Module } from "@nestjs/common";

import { InternalEvalsController } from "./internal-evals.controller.js";
import { InternalSignatureGuard } from "../internal/internal-signature.guard.js";

/**
 * D08's signed worker -> API surface for the eval harness. Kept separate from
 * `InternalModule` (A08's) rather than added to it, since this WP's file
 * boundary is `apps/api/src/evals/**` and not `apps/api/src/internal/**`; the
 * guard is imported, not redefined, so there is exactly one place that HMAC
 * scheme is implemented.
 */
@Module({
  controllers: [InternalEvalsController],
  providers: [InternalSignatureGuard],
})
export class EvalsModule {}

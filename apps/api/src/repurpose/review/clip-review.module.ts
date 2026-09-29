import { Module } from "@nestjs/common";

import { ClientReviewService } from "./client-review.service.js";
import { ClipApprovalGate } from "./clip-approval.gate.js";
import { ClipReviewController } from "./clip-review.controller.js";
import { ClipReviewService } from "./clip-review.service.js";
import { PublicReviewController } from "./public-review.controller.js";
import { ReviewExportListener } from "./review-export.listener.js";
import { ReviewNotifier } from "./review-notifier.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";

import type { Provider } from "@nestjs/common";

/** The module's own providers, exported for the injector test. */
export const CLIP_REVIEW_PROVIDERS: Provider[] = [
  ClipReviewService,
  ClientReviewService,
  ClipApprovalGate,
  ReviewNotifier,
  ReviewExportListener,
];

/**
 * Clip review (2026-10-03): approving a run's clips before they go out,
 * comments on them, and client review links (`/review`, no account).
 *
 * `WorkspacesModule` for the guard chain and `EntitlementService` (the
 * `repurpose_flow` check). `PrismaService`, `CommonAuditService`, the object
 * stores, `RateLimitService` and `NotifyService` come from global modules, and
 * `export.completed` from the global event emitter. Nothing here is needed by
 * another module: posting reads the approval through its own binding of
 * `ClipApprovalGate`, which is stateless over the database.
 *
 * Needs no flag of its own: the team's routes answer 404 while `repurpose_flow`
 * is off, the client's while `shares.public` is, and "Clips need approval before
 * posting" is off until an owner or admin turns it on.
 */
@Module({
  imports: [WorkspacesModule],
  controllers: [ClipReviewController, PublicReviewController],
  providers: CLIP_REVIEW_PROVIDERS,
})
export class ClipReviewModule {}

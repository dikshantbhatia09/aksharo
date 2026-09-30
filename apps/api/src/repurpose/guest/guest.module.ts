import { Module } from "@nestjs/common";

import { GuestLinksController } from "./guest-links.controller.js";
import { GuestLinksService } from "./guest-links.service.js";
import { GuestPageService } from "./guest-page.service.js";
import { PublicGuestController } from "./public-guest.controller.js";
import { WorkspacesModule } from "../../workspaces/workspaces.module.js";
import { ClipReviewModule } from "../review/clip-review.module.js";

import type { Provider } from "@nestjs/common";

/** The module's own providers, exported for the injector test. */
export const GUEST_PROVIDERS: Provider[] = [GuestLinksService, GuestPageService];

/**
 * Guest pages (2026-10-05): a link a podcaster sends their guest, where the
 * guest downloads the clips they appear in with no account
 * (`/repurpose/runs/:id/guest-links` for the team, `/guest` for the guest).
 *
 * `ClipReviewModule` for the machinery the client review links already have
 * (the `repurpose_flow` check, the run and its listed clips, the approval
 * gate), `WorkspacesModule` for the guard chain. `PrismaService`,
 * `CommonAuditService`, the object stores and `RateLimitService` come from
 * global modules.
 *
 * Needs no flag of its own: the team's routes answer 404 while `repurpose_flow`
 * is off, the guest's while `shares.public` is.
 */
@Module({
  imports: [WorkspacesModule, ClipReviewModule],
  controllers: [GuestLinksController, PublicGuestController],
  providers: GUEST_PROVIDERS,
})
export class RepurposeGuestModule {}

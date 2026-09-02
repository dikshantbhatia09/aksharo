import { Module } from "@nestjs/common";

import { EntitlementService } from "./entitlement.service.js";
import { InvitationsController } from "./invitations.controller.js";
import { MembersService } from "./members.service.js";
import { WorkspaceMemberGuard } from "./workspace-member.guard.js";
import { LoggingWorkspaceNotifier, WORKSPACE_NOTIFIER } from "./workspace-notifier.js";
import { WorkspacesController } from "./workspaces.controller.js";
import { WorkspacesService } from "./workspaces.service.js";
import { UsersModule } from "../users/users.module.js";

/**
 * Workspaces, the tax profile, memberships and the entitlement stub (A05).
 *
 * `WORKSPACE_NOTIFIER` is bound to the logging stand-in: A25 owns mail delivery
 * and swaps this one `useClass` for a `notify`-queue producer, exactly as B02
 * swaps `CREDITS_FACADE`.
 */
@Module({
  imports: [UsersModule],
  controllers: [WorkspacesController, InvitationsController],
  providers: [
    WorkspacesService,
    MembersService,
    EntitlementService,
    WorkspaceMemberGuard,
    { provide: WORKSPACE_NOTIFIER, useClass: LoggingWorkspaceNotifier },
  ],
  // `WorkspaceMemberGuard` is exported so a route wearing it can live outside
  // this module — B02's `CreditsController` mounts `/workspaces/:id/usage` and
  // `/workspaces/:id/credits` under it (THREAT-MODEL T4), and Nest can only
  // resolve a guard passed to `@UseGuards` as a class if it is a provider of a
  // module reachable from the one declaring the route.
  exports: [WorkspacesService, MembersService, EntitlementService, WorkspaceMemberGuard],
})
export class WorkspacesModule {}

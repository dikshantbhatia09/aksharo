import { Module } from "@nestjs/common";

import { RequiresEntitlementGuard } from "./requires-entitlement.guard.js";
import { WorkspacesModule } from "../workspaces/workspaces.module.js";

/**
 * `@RequiresEntitlement(...)` and its guard, for any module that gates a route on
 * plan + seats + passes + flags (04 §Entitlement enforcement).
 *
 * Re-exports `WorkspacesModule` so an importer gets `EntitlementService` too
 * (`RequiresEntitlementGuard` needs it, and so does anything reading an
 * entitlement directly rather than through the guard) without importing both
 * modules by hand.
 */
@Module({
  imports: [WorkspacesModule],
  providers: [RequiresEntitlementGuard],
  exports: [WorkspacesModule, RequiresEntitlementGuard],
})
export class EntitlementsModule {}

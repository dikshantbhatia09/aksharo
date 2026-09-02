import { SetMetadata } from "@nestjs/common";

import type { $Enums } from "@prisma/client";

/** Reflector key {@link AdminGuard} reads to know which roles a route requires. */
export const ADMIN_ROLES_KEY = "montaj:admin:roles";

/**
 * Restricts an `/admin/**` route to one or more {@link $Enums.AdminRoleName}s.
 * `superadmin` always passes regardless of what is listed (`AdminGuard`).
 *
 * A controller or handler with no `@AdminRoles(...)` still requires a valid
 * `kind: "admin"` token — it just does not narrow by role, which is correct
 * for read-only cross-cutting views every admin role may see (e.g. the users
 * search panel). Money and role-management routes must declare theirs
 * explicitly per the brief (B13 scope §1, §4).
 */
export const AdminRoles = (
  ...roles: readonly $Enums.AdminRoleName[]
): MethodDecorator & ClassDecorator => SetMetadata(ADMIN_ROLES_KEY, roles);

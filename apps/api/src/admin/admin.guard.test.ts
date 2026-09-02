import "reflect-metadata";

import { HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_ROLES_KEY } from "./admin-roles.decorator.js";
import { AdminGuard, adminOf } from "./admin.guard.js";
import { createFakePrisma, FakeDb } from "../../test/fakes.js";
import { ERROR_CODES } from "../common/errors/error-codes.js";

import type { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import type { AuthenticatedRequest, AuthPrincipal } from "../common/guards/principal.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { ExecutionContext } from "@nestjs/common";
import type { $Enums } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";

/** `context(request, requiredRoles)` — `requiredRoles` stands in for `@AdminRoles(...)` on the route. */
function context(
  request: Partial<AuthenticatedRequest>,
  requiredRoles?: readonly $Enums.AdminRoleName[],
): ExecutionContext {
  const handler = (): undefined => undefined;
  if (requiredRoles !== undefined) {
    Reflect.defineMetadata(ADMIN_ROLES_KEY, requiredRoles, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function principalFor(userId: string, kind: $Enums.ClientKind = "admin"): AuthPrincipal {
  return { userId, workspaceId: WS, role: "owner", kind, jti: "j" };
}

let db: FakeDb;
let prisma: PrismaService;
let jwt: { canActivate: ReturnType<typeof vi.fn> };
let guard: AdminGuard;

beforeEach(() => {
  db = new FakeDb();
  prisma = createFakePrisma(db) as unknown as PrismaService;
  jwt = { canActivate: vi.fn(async () => true) };
  // A real Reflector — the `context()` helper above sets the metadata `SetMetadata`
  // would have via `getHandler()`/`getClass()`, so `getAllAndOverride` reads it back
  // exactly as it would off a live route.
  guard = new AdminGuard(jwt as unknown as JwtAuthGuard, prisma, new Reflector());
});

describe("AdminGuard — role matrix (B13, THREAT-MODEL T20)", () => {
  it("401s when the guard chain left no principal behind", async () => {
    await expect(guard.canActivate(context({ path: "/admin/dlq" }))).rejects.toMatchObject({
      code: ERROR_CODES.unauthorized,
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
  });

  it("stops at JwtAuthGuard when the token itself is refused", async () => {
    jwt.canActivate.mockResolvedValueOnce(false);
    await expect(guard.canActivate(context({ path: "/admin/dlq" }))).resolves.toBe(false);
    expect(db.users.size).toBe(0);
  });

  it("403s a valid, non-admin-kind token (a plain web/desktop session)", async () => {
    const user = db.user({ isAdmin: false });
    db.adminRole({ userId: user.id, role: "support" });
    const request = { principal: principalFor(user.id, "web"), path: "/admin/dlq" };
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("403s an admin-kind token whose user has no admin_roles row", async () => {
    const user = db.user({ isAdmin: false });
    const request = { principal: principalFor(user.id, "admin"), path: "/admin/dlq" };
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("403s an admin whose account has been deleted", async () => {
    const admin = db.user({ isAdmin: true, deletedAt: new Date() });
    db.adminRole({ userId: admin.id, role: "superadmin" });
    const request = { principal: principalFor(admin.id), path: "/admin/dlq" };
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("403s a token whose user no longer exists", async () => {
    const request = { principal: principalFor("01JCGHOST00000000000000000"), path: "/admin/dlq" };
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("lets an admin token with no @AdminRoles() restriction through on the roles it holds", async () => {
    const support = db.user({ isAdmin: false });
    db.adminRole({ userId: support.id, role: "support" });
    const request = { principal: principalFor(support.id), path: "/admin/support" };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
  });

  it("403s support against a route restricted to finance", async () => {
    const support = db.user({ isAdmin: false });
    db.adminRole({ userId: support.id, role: "support" });
    const request = { principal: principalFor(support.id), path: "/admin/credits/adjust" };
    await expect(guard.canActivate(context(request, ["finance"]))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("lets finance through a route restricted to finance", async () => {
    const finance = db.user({ isAdmin: false });
    db.adminRole({ userId: finance.id, role: "finance" });
    const request = { principal: principalFor(finance.id), path: "/admin/credits/adjust" };
    await expect(guard.canActivate(context(request, ["finance"]))).resolves.toBe(true);
  });

  it("superadmin passes any @AdminRoles(...) regardless of which roles are listed", async () => {
    const root = db.user({ isAdmin: false });
    db.adminRole({ userId: root.id, role: "superadmin" });
    const request = { principal: principalFor(root.id), path: "/admin/routing-weights" };
    await expect(guard.canActivate(context(request, ["finance"]))).resolves.toBe(true);
    await expect(guard.canActivate(context(request, ["ops", "content"]))).resolves.toBe(true);
  });

  it("revoking the role takes effect immediately, independent of the token's 30-minute lifetime", async () => {
    const finance = db.user({ isAdmin: false });
    const grant = db.adminRole({ userId: finance.id, role: "finance" });
    const request = { principal: principalFor(finance.id), path: "/admin/credits/adjust" };
    await expect(guard.canActivate(context(request, ["finance"]))).resolves.toBe(true);

    // Same still-valid admin token; the grant is revoked underneath it.
    db.adminRoles.set(grant.id, { ...grant, revokedAt: new Date() });
    await expect(guard.canActivate(context(request, ["finance"]))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("holding an unrelated role does not satisfy a route restricted to another", async () => {
    const contentEditor = db.user({ isAdmin: false });
    db.adminRole({ userId: contentEditor.id, role: "content" });
    const request = { principal: principalFor(contentEditor.id), path: "/admin/affiliates/review" };
    await expect(guard.canActivate(context(request, ["ops", "finance"]))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });
});

describe("adminOf", () => {
  it("carries the acting user, their active roles and their address, for the audit trail", async () => {
    const admin = db.user({ isAdmin: false });
    db.adminRole({ userId: admin.id, role: "finance" });
    const request = {
      principal: principalFor(admin.id),
      ip: "203.0.113.7",
      headers: {},
      path: "/admin/credits/adjust",
    } as unknown as AuthenticatedRequest;

    await guard.canActivate(context(request));

    expect(adminOf(request)).toEqual({
      userId: admin.id,
      workspaceId: WS,
      roles: ["finance"],
      ip: "203.0.113.7",
    });
  });

  it("401s rather than attributing an action to nobody", () => {
    expect(() => adminOf({ headers: {} } as unknown as AuthenticatedRequest)).toThrow();
  });
});

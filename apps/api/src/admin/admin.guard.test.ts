import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminGuard, adminOf } from "./admin.guard.js";
import { createFakePrisma, FakeDb } from "../../test/fakes.js";
import { ERROR_CODES } from "../common/errors/error-codes.js";

import type { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import type { AuthenticatedRequest, AuthPrincipal } from "../common/guards/principal.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { ExecutionContext } from "@nestjs/common";

const WS = "01JCWS0000000000000000000A";

function context(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function principalFor(userId: string): AuthPrincipal {
  return { userId, workspaceId: WS, role: "owner", kind: "web", jti: "j" };
}

let db: FakeDb;
let prisma: PrismaService;
let jwt: { canActivate: ReturnType<typeof vi.fn> };
let guard: AdminGuard;

beforeEach(() => {
  db = new FakeDb();
  prisma = createFakePrisma(db) as unknown as PrismaService;
  jwt = { canActivate: vi.fn(async () => true) };
  guard = new AdminGuard(jwt as unknown as JwtAuthGuard, prisma);
});

describe("AdminGuard", () => {
  it("lets a platform admin through", async () => {
    const admin = db.user({ isAdmin: true });
    const request = { principal: principalFor(admin.id), path: "/admin/dlq" };

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
  });

  it("403s an authenticated non-admin (THREAT-MODEL T20)", async () => {
    const user = db.user({ isAdmin: false });
    const request = { principal: principalFor(user.id), path: "/admin/dlq" };

    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      code: ERROR_CODES.forbidden,
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("403s an admin whose account has been deleted", async () => {
    const admin = db.user({ isAdmin: true, deletedAt: new Date() });
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

  it("reads the flag from the database every time, so revocation is immediate", async () => {
    const admin = db.user({ isAdmin: true });
    const request = { principal: principalFor(admin.id), path: "/admin/dlq" };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);

    // Same token, flag revoked in the database.
    db.users.set(admin.id, { ...admin, isAdmin: false });
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      httpStatus: HttpStatus.FORBIDDEN,
    });
  });

  it("stops at JwtAuthGuard when the token itself is refused", async () => {
    jwt.canActivate.mockResolvedValueOnce(false);
    await expect(guard.canActivate(context({ path: "/admin/dlq" }))).resolves.toBe(false);
    expect(db.users.size).toBe(0);
  });

  it("401s if the guard chain left no principal behind", async () => {
    await expect(guard.canActivate(context({ path: "/admin/dlq" }))).rejects.toMatchObject({
      code: ERROR_CODES.unauthorized,
      httpStatus: HttpStatus.UNAUTHORIZED,
    });
  });
});

describe("adminOf", () => {
  it("carries the acting user and their address, for the audit trail", () => {
    const request = {
      principal: principalFor("01JCADMIN00000000000000000"),
      ip: "203.0.113.7",
      headers: {},
    } as unknown as AuthenticatedRequest;

    expect(adminOf(request)).toEqual({
      userId: "01JCADMIN00000000000000000",
      workspaceId: WS,
      ip: "203.0.113.7",
    });
  });

  it("401s rather than attributing an action to nobody", () => {
    expect(() => adminOf({ headers: {} } as unknown as AuthenticatedRequest)).toThrow();
  });
});

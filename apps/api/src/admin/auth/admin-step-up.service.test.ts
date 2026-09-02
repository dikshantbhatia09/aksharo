import { describe, expect, it, vi } from "vitest";

import { AdminStepUpService } from "./admin-step-up.service.js";
import { currentTotpCode, generateTotpSecret } from "./totp.js";
import { AppException } from "../../common/errors/error-codes.js";

const USER = "01JUSER000000000000000000A";
const WS = "01JWORKSPACE00000000000000";
const SECRET = generateTotpSecret();

function harness() {
  const prisma = {
    adminRole: { findMany: vi.fn() },
    adminTotp: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  };
  const tokens = { mintAccessToken: vi.fn() };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new AdminStepUpService(prisma as never, tokens as never, audit as never);
  return { service, prisma, tokens, audit };
}

describe("AdminStepUpService.enroll", () => {
  it("403s a user with no active admin role", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([]);
    await expect(h.service.enroll(USER, "u@x.com")).rejects.toBeInstanceOf(AppException);
    expect(h.prisma.adminTotp.upsert).not.toHaveBeenCalled();
  });

  it("issues a secret and otpauth URI for an admin with no verified secret yet", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue(null);

    const result = await h.service.enroll(USER, "u@x.com");

    expect(result.secret).toMatch(/^[A-Z2-7]+$/);
    expect(result.otpauthUrl).toContain("otpauth://totp/");
    expect(h.prisma.adminTotp.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
  });

  it("refuses to re-enrol over an already-verified secret", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue({ verifiedAt: new Date() });

    await expect(h.service.enroll(USER, "u@x.com")).rejects.toBeInstanceOf(AppException);
    expect(h.prisma.adminTotp.upsert).not.toHaveBeenCalled();
  });
});

describe("AdminStepUpService.verifyEnrollment", () => {
  it("403s a user with no active admin role", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([]);
    await expect(h.service.verifyEnrollment(USER, "123456")).rejects.toBeInstanceOf(AppException);
  });

  it("fails when no secret was ever enrolled", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue(null);
    await expect(h.service.verifyEnrollment(USER, "123456")).rejects.toBeInstanceOf(AppException);
  });

  it("rejects a wrong code without marking verified", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue({ secret: SECRET, verifiedAt: null });
    await expect(h.service.verifyEnrollment(USER, "000000")).rejects.toBeInstanceOf(AppException);
    expect(h.prisma.adminTotp.update).not.toHaveBeenCalled();
  });

  it("marks verified_at on the first correct code", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue({ secret: SECRET, verifiedAt: null });
    await h.service.verifyEnrollment(USER, currentTotpCode(SECRET));
    expect(h.prisma.adminTotp.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER },
        data: expect.objectContaining({ verifiedAt: expect.any(Date) }),
      }),
    );
  });
});

describe("AdminStepUpService.stepUp", () => {
  it("403s a user with no active admin role", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([]);
    await expect(h.service.stepUp(USER, WS, "owner", "123456", undefined)).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it("refuses to step up before TOTP has been verified", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue({ secret: SECRET, verifiedAt: null });
    await expect(h.service.stepUp(USER, WS, "owner", "123456", undefined)).rejects.toBeInstanceOf(
      AppException,
    );
    expect(h.tokens.mintAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a wrong code and audits the denial", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue({ secret: SECRET, verifiedAt: new Date() });

    await expect(
      h.service.stepUp(USER, WS, "owner", "000000", "203.0.113.5"),
    ).rejects.toBeInstanceOf(AppException);
    expect(h.tokens.mintAccessToken).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.step_up.denied", actorId: USER }),
    );
  });

  it("mints a kind:admin token carrying the active roles, and audits the grant", async () => {
    const h = harness();
    h.prisma.adminRole.findMany.mockResolvedValue([{ role: "finance" }, { role: "ops" }]);
    h.prisma.adminTotp.findUnique.mockResolvedValue({ secret: SECRET, verifiedAt: new Date() });
    h.tokens.mintAccessToken.mockReturnValue({
      accessToken: "signed.jwt.here",
      expiresIn: 1800,
      jti: "01JJTI0000000000000000000A",
    });

    const result = await h.service.stepUp(
      USER,
      WS,
      "owner",
      currentTotpCode(SECRET),
      "203.0.113.5",
    );

    expect(result).toEqual({
      accessToken: "signed.jwt.here",
      expiresIn: 1800,
      adminRoles: ["finance", "ops"],
    });
    expect(h.tokens.mintAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        workspaceId: WS,
        kind: "admin",
        adminRoles: ["finance", "ops"],
      }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.step_up.granted", actorId: USER }),
    );
  });
});

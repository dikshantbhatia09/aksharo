import { describe, expect, it, vi } from "vitest";

import { AdminPartnerCatalogueController } from "./admin-partner-catalogue.controller.js";

import type { AuthenticatedRequest, AuthPrincipal } from "../../common/guards/principal.js";

interface GrantRow {
  id: string;
  workspaceId: string;
  providerAssetId: string | null;
  useContext: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  reportStatus: "reported" | "unreported" | "no_usage";
}

function harness() {
  const catalogue = {
    listGrants: vi.fn(async (): Promise<GrantRow[]> => []),
    adminRevoke: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const controller = new AdminPartnerCatalogueController(catalogue as never, audit as never);
  return { controller, catalogue, audit };
}

function request(): AuthenticatedRequest {
  const principal: AuthPrincipal = {
    userId: "01JADMIN00000000000000000A",
    workspaceId: "01JWORKSPACE00000000000000",
    role: "owner",
    kind: "admin",
    jti: "j",
  };
  return {
    principal,
    adminActiveRoles: ["superadmin"],
    ip: "203.0.113.9",
    headers: {},
  } as unknown as AuthenticatedRequest;
}

describe("AdminPartnerCatalogueController.listGrants (D04b2 scope §5)", () => {
  it("delegates to PartnerCatalogueService.listGrants", async () => {
    const h = harness();
    const rows = [
      {
        id: "g1",
        workspaceId: "ws1",
        providerAssetId: "mock-sfx-0001",
        useContext: "pass_item",
        status: "active",
        expiresAt: null,
        createdAt: "2026-09-03T00:00:00.000Z",
        reportStatus: "no_usage" as const,
      },
    ];
    h.catalogue.listGrants.mockResolvedValue(rows);

    await expect(h.controller.listGrants()).resolves.toEqual(rows);
    expect(h.catalogue.listGrants).toHaveBeenCalledOnce();
  });
});

describe("AdminPartnerCatalogueController.revoke", () => {
  it("calls adminRevoke and writes an audit record", async () => {
    const h = harness();

    const result = await h.controller.revoke(request(), "g1");

    expect(result).toEqual({ revoked: true });
    expect(h.catalogue.adminRevoke).toHaveBeenCalledWith("g1");
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.partner_catalogue.grant_revoked",
        resource: "asset_clearance_grant",
        resourceId: "g1",
        actorId: "01JADMIN00000000000000000A",
        actorKind: "admin",
      }),
    );
  });
});

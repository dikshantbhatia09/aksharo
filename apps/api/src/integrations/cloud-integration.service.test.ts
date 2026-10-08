import { describe, expect, it, vi } from "vitest";
import { CloudIntegrationService } from "./cloud-integration.service.js";
import { VaultService } from "./vault.service.js";

describe("CloudIntegrationService", () => {
  const vault = new VaultService("test-secret-vault-key");

  it("saves integration with encrypted tokens and lists them without exposing tokens", async () => {
    const mockDb: any[] = [];
    const prisma = {
      workspaceCloudIntegration: {
        upsert: vi.fn().mockImplementation(({ create }) => {
          const row = {
            id: "integration-1",
            workspaceId: create.workspaceId,
            provider: create.provider,
            accountEmail: create.accountEmail,
            accessToken: create.accessToken,
            refreshToken: create.refreshToken,
            expiresAt: create.expiresAt,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockDb.push(row);
          return row;
        }),
        findMany: vi.fn().mockImplementation(() => mockDb),
        findFirst: vi.fn().mockImplementation(() => mockDb[0]),
      },
    } as any;

    const service = new CloudIntegrationService(prisma, vault);

    const saved = await service.saveIntegration("ws-123", {
      provider: "GOOGLE_DRIVE",
      accountEmail: "creator@example.com",
      accessToken: "plain-access-token-123",
      refreshToken: "plain-refresh-token-456",
    });

    expect(saved.provider).toBe("GOOGLE_DRIVE");
    expect(saved.accountEmail).toBe("creator@example.com");
    expect(saved.hasRefreshToken).toBe(true);

    // Verify token was stored encrypted in DB
    expect(mockDb[0].accessToken).not.toBe("plain-access-token-123");
    expect(mockDb[0].accessToken.split(":")).toHaveLength(3);

    // Verify list doesn't leak tokens
    const list = await service.listIntegrations("ws-123");
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("accessToken");
    expect(list[0]).not.toHaveProperty("refreshToken");

    // Verify decrypted retrieval
    const decrypted = await service.getDecryptedToken("ws-123", "GOOGLE_DRIVE");
    expect(decrypted?.accessToken).toBe("plain-access-token-123");
    expect(decrypted?.refreshToken).toBe("plain-refresh-token-456");
  });
});


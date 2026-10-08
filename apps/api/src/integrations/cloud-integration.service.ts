import { HttpStatus, Injectable } from "@nestjs/common";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import { VaultService } from "./vault.service.js";
import type { SaveCloudIntegrationDto } from "./integrations.dto.js";

export interface CloudIntegrationSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly accountEmail: string;
  readonly hasRefreshToken: boolean;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DecryptedCloudToken {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly accountEmail: string;
}

@Injectable()
export class CloudIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: VaultService,
  ) {}

  /**
   * List connected cloud storage accounts for a workspace.
   * Access and refresh tokens remain encrypted at rest and are not exposed.
   */
  async listIntegrations(workspaceId: string): Promise<CloudIntegrationSummary[]> {
    const integrations = await this.prisma.workspaceCloudIntegration.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });

    return integrations.map((item) => ({
      id: item.id,
      workspaceId: item.workspaceId,
      provider: item.provider,
      accountEmail: item.accountEmail,
      hasRefreshToken: Boolean(item.refreshToken),
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  }

  /**
   * Save or refresh third-party cloud OAuth tokens, encrypted with AES-256-GCM.
   */
  async saveIntegration(
    workspaceId: string,
    input: SaveCloudIntegrationDto,
  ): Promise<CloudIntegrationSummary> {
    const encryptedAccessToken = this.vault.encrypt(input.accessToken);
    const encryptedRefreshToken = input.refreshToken
      ? this.vault.encrypt(input.refreshToken)
      : null;

    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    const saved = await this.prisma.workspaceCloudIntegration.upsert({
      where: {
        workspaceId_provider_accountEmail: {
          workspaceId,
          provider: input.provider.toUpperCase(),
          accountEmail: input.accountEmail.toLowerCase(),
        },
      },
      create: {
        workspaceId,
        provider: input.provider.toUpperCase(),
        accountEmail: input.accountEmail.toLowerCase(),
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
      },
      update: {
        accessToken: encryptedAccessToken,
        ...(encryptedRefreshToken ? { refreshToken: encryptedRefreshToken } : {}),
        expiresAt,
        updatedAt: new Date(),
      },
    });

    return {
      id: saved.id,
      workspaceId: saved.workspaceId,
      provider: saved.provider,
      accountEmail: saved.accountEmail,
      hasRefreshToken: Boolean(saved.refreshToken),
      expiresAt: saved.expiresAt,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  /**
   * Decrypt and return the OAuth access and refresh token for server-side ingestion.
   */
  async getDecryptedToken(
    workspaceId: string,
    provider: string,
  ): Promise<DecryptedCloudToken | null> {
    const integration = await this.prisma.workspaceCloudIntegration.findFirst({
      where: {
        workspaceId,
        provider: provider.toUpperCase(),
      },
      orderBy: { updatedAt: "desc" },
    });

    if (!integration) {
      return null;
    }

    const accessToken = this.vault.decrypt(integration.accessToken);
    const refreshToken = integration.refreshToken
      ? this.vault.decrypt(integration.refreshToken)
      : null;

    return {
      accessToken,
      refreshToken,
      expiresAt: integration.expiresAt,
      accountEmail: integration.accountEmail,
    };
  }

  /**
   * Disconnect a third-party cloud integration.
   */
  async deleteIntegration(workspaceId: string, id: string): Promise<void> {
    const integration = await this.prisma.workspaceCloudIntegration.findFirst({
      where: { id, workspaceId },
    });

    if (!integration) {
      throw new AppException(
        ERROR_CODES.notFound,
        "Cloud integration not found",
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.workspaceCloudIntegration.delete({
      where: { id },
    });
  }
}


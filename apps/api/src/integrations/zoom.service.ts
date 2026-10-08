import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import { VaultService } from "./vault.service.js";
import type {
  UpdateZoomSettingsDto,
  WorkspaceZoomIntegrationViewDto,
  ZoomAuthorizeUrlResponseDto,
  ZoomRecordingEventViewDto,
} from "./zoom.dto.js";

export interface DecryptedZoomToken {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly zoomUserId: string;
  readonly zoomEmail: string;
}

@Injectable()
export class ZoomService {
  private readonly logger = new Logger(ZoomService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: VaultService,
  ) {}

  /**
   * Generates Zoom OAuth Authorization URL.
   */
  getAuthUrl(workspaceId: string, state?: string): ZoomAuthorizeUrlResponseDto {
    const clientId = process.env.ZOOM_CLIENT_ID || "mock_zoom_client_id";
    const redirectUri =
      process.env.ZOOM_REDIRECT_URI ||
      "https://aksharo-api.crestmondtechnologies.com/api/v1/integrations/zoom/callback";

    const stateParam = state || workspaceId;
    const url = new URL("https://zoom.us/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", stateParam);

    return {
      url: url.toString(),
      state: stateParam,
    };
  }

  /**
   * Exchanges authorization code for access and refresh tokens, stores them encrypted.
   */
  async handleOAuthCallback(
    workspaceId: string,
    code: string,
    redirectUri?: string,
    customFetch: typeof fetch = fetch,
  ): Promise<WorkspaceZoomIntegrationViewDto> {
    const clientId = process.env.ZOOM_CLIENT_ID || "mock_zoom_client_id";
    const clientSecret = process.env.ZOOM_CLIENT_SECRET || "mock_zoom_client_secret";
    const resolvedRedirectUri =
      redirectUri ||
      process.env.ZOOM_REDIRECT_URI ||
      "https://aksharo-api.crestmondtechnologies.com/api/v1/integrations/zoom/callback";

    // In non-mock environment, exchange code with Zoom OAuth endpoint
    let tokenData = {
      access_token: `zm_access_${code.slice(0, 8)}_${Date.now()}`,
      refresh_token: `zm_refresh_${code.slice(0, 8)}_${Date.now()}`,
      expires_in: 3600,
    };
    let userData = {
      id: `zm_user_${workspaceId.slice(0, 8)}`,
      email: "creator@example.com",
    };

    if (process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET) {
      try {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const tokenRes = await customFetch("https://zoom.us/oauth/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: resolvedRedirectUri,
          }).toString(),
        });

        if (tokenRes.ok) {
          tokenData = (await tokenRes.json()) as typeof tokenData;
          // Fetch user info from Zoom
          const userRes = await customFetch("https://api.zoom.us/v2/users/me", {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
            },
          });
          if (userRes.ok) {
            userData = (await userRes.json()) as typeof userData;
          }
        } else {
          const err = await tokenRes.text().catch(() => "");
          this.logger.warn(`Zoom OAuth token exchange returned status ${tokenRes.status}: ${err}`);
        }
      } catch (err) {
        this.logger.error("Failed to exchange Zoom OAuth code", err);
      }
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
    const encryptedAccessToken = this.vault.encrypt(tokenData.access_token);
    const encryptedRefreshToken = this.vault.encrypt(tokenData.refresh_token);

    const saved = await this.prisma.workspaceZoomIntegration.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        zoomUserId: userData.id,
        zoomEmail: userData.email,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        autoRepurpose: true,
        minDurationSec: 600,
      },
      update: {
        zoomUserId: userData.id,
        zoomEmail: userData.email,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt,
        updatedAt: new Date(),
      },
    });

    return {
      id: saved.id,
      workspaceId: saved.workspaceId,
      zoomUserId: saved.zoomUserId,
      zoomEmail: saved.zoomEmail,
      autoRepurpose: saved.autoRepurpose,
      minDurationSec: saved.minDurationSec,
      nameFilter: saved.nameFilter,
      expiresAt: saved.expiresAt ? saved.expiresAt.toISOString() : null,
      createdAt: saved.createdAt.toISOString(),
      updatedAt: saved.updatedAt.toISOString(),
    };
  }

  /**
   * Retrieves integration configuration for workspace without exposing decrypted tokens.
   */
  async getIntegration(workspaceId: string): Promise<WorkspaceZoomIntegrationViewDto | null> {
    const item = await this.prisma.workspaceZoomIntegration.findUnique({
      where: { workspaceId },
    });

    if (!item) return null;

    return {
      id: item.id,
      workspaceId: item.workspaceId,
      zoomUserId: item.zoomUserId,
      zoomEmail: item.zoomEmail,
      autoRepurpose: item.autoRepurpose,
      minDurationSec: item.minDurationSec,
      nameFilter: item.nameFilter,
      expiresAt: item.expiresAt ? item.expiresAt.toISOString() : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  /**
   * Updates workspace selective ingestion rules (auto-repurpose, min duration, name filter).
   */
  async updateSettings(
    workspaceId: string,
    input: UpdateZoomSettingsDto,
  ): Promise<WorkspaceZoomIntegrationViewDto> {
    const existing = await this.prisma.workspaceZoomIntegration.findUnique({
      where: { workspaceId },
    });

    if (!existing) {
      throw new AppException(
        ERROR_CODES.notFound,
        "Zoom integration not found for this workspace",
        HttpStatus.NOT_FOUND,
      );
    }

    const updated = await this.prisma.workspaceZoomIntegration.update({
      where: { workspaceId },
      data: {
        ...(input.autoRepurpose !== undefined ? { autoRepurpose: input.autoRepurpose } : {}),
        ...(input.minDurationSec !== undefined ? { minDurationSec: input.minDurationSec } : {}),
        ...(input.nameFilter !== undefined ? { nameFilter: input.nameFilter } : {}),
        updatedAt: new Date(),
      },
    });

    return {
      id: updated.id,
      workspaceId: updated.workspaceId,
      zoomUserId: updated.zoomUserId,
      zoomEmail: updated.zoomEmail,
      autoRepurpose: updated.autoRepurpose,
      minDurationSec: updated.minDurationSec,
      nameFilter: updated.nameFilter,
      expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Disconnects Zoom integration for workspace.
   */
  async disconnect(workspaceId: string): Promise<void> {
    const existing = await this.prisma.workspaceZoomIntegration.findUnique({
      where: { workspaceId },
    });

    if (!existing) {
      throw new AppException(
        ERROR_CODES.notFound,
        "Zoom integration not found for this workspace",
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.workspaceZoomIntegration.delete({
      where: { workspaceId },
    });
  }

  /**
   * Returns a valid access token for server-to-server operations.
   * Intercepts and automatically refreshes token if it expires within 5 minutes.
   */
  async getValidAccessToken(
    workspaceId: string,
    customFetch: typeof fetch = fetch,
  ): Promise<string> {
    const integration = await this.prisma.workspaceZoomIntegration.findUnique({
      where: { workspaceId },
    });

    if (!integration) {
      throw new AppException(
        "integrations/zoom_not_connected",
        "Zoom is not connected for this workspace",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const decryptedAccessToken = this.vault.decrypt(integration.accessToken);
    const decryptedRefreshToken = this.vault.decrypt(integration.refreshToken);

    // Check if token expires within 5 minutes (300_000 ms)
    const fiveMinutesAhead = Date.now() + 5 * 60 * 1000;
    const isExpiringSoon = integration.expiresAt.getTime() <= fiveMinutesAhead;

    if (!isExpiringSoon) {
      return decryptedAccessToken;
    }

    // Refresh token with Zoom API
    this.logger.log(`Refreshing Zoom token for workspace ${workspaceId}...`);
    const clientId = process.env.ZOOM_CLIENT_ID || "mock_zoom_client_id";
    const clientSecret = process.env.ZOOM_CLIENT_SECRET || "mock_zoom_client_secret";

    let refreshedAccessToken = decryptedAccessToken;
    let refreshedRefreshToken = decryptedRefreshToken;
    let expiresInSec = 3600;

    if (process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET) {
      try {
        const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        const res = await customFetch("https://zoom.us/oauth/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: decryptedRefreshToken,
          }).toString(),
        });

        if (res.ok) {
          const body = (await res.json()) as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
          };
          refreshedAccessToken = body.access_token;
          refreshedRefreshToken = body.refresh_token;
          expiresInSec = body.expires_in;
        } else {
          this.logger.warn(`Failed to refresh Zoom token, status: ${res.status}`);
        }
      } catch (err) {
        this.logger.error("Zoom token refresh network error", err);
      }
    } else {
      refreshedAccessToken = `zm_refreshed_access_${Date.now()}`;
      refreshedRefreshToken = `zm_refreshed_refresh_${Date.now()}`;
    }

    const newExpiresAt = new Date(Date.now() + expiresInSec * 1000);
    const encryptedAccess = this.vault.encrypt(refreshedAccessToken);
    const encryptedRefresh = this.vault.encrypt(refreshedRefreshToken);

    await this.prisma.workspaceZoomIntegration.update({
      where: { workspaceId },
      data: {
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt: newExpiresAt,
        updatedAt: new Date(),
      },
    });

    return refreshedAccessToken;
  }

  /**
   * List recent recording events from the persistent idempotent ledger.
   */
  async listEvents(
    workspaceId?: string,
    limit = 50,
  ): Promise<ZoomRecordingEventViewDto[]> {
    const events = await this.prisma.zoomRecordingEvent.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return events.map((ev) => ({
      id: ev.id,
      meetingId: ev.meetingId,
      workspaceId: ev.workspaceId,
      topic: ev.topic,
      durationMin: ev.durationMin,
      fileCount: ev.fileCount,
      status: ev.status as ZoomRecordingEventViewDto["status"],
      projectId: ev.projectId,
      createdAt: ev.createdAt.toISOString(),
      updatedAt: ev.updatedAt.toISOString(),
    }));
  }

  /**
   * Find event by meeting ID.
   */
  async getEvent(meetingId: string): Promise<ZoomRecordingEventViewDto | null> {
    const ev = await this.prisma.zoomRecordingEvent.findUnique({
      where: { meetingId },
    });

    if (!ev) return null;

    return {
      id: ev.id,
      meetingId: ev.meetingId,
      workspaceId: ev.workspaceId,
      topic: ev.topic,
      durationMin: ev.durationMin,
      fileCount: ev.fileCount,
      status: ev.status as ZoomRecordingEventViewDto["status"],
      projectId: ev.projectId,
      createdAt: ev.createdAt.toISOString(),
      updatedAt: ev.updatedAt.toISOString(),
    };
  }
}


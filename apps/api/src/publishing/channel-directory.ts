import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { isSupportedProvider, rulesFor, type SupportedProvider } from "./platforms.js";
import { canonicalProviderOf } from "./postiz/postiz-format.js";
import { PostizClient } from "./postiz/postiz.client.js";
import { CHANNEL_CACHE_MS } from "./publishing.constants.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { PostizIntegration } from "./postiz/postiz.schemas.js";
import type { ChannelView } from "./publishing.dto.js";
import type { ChannelConnection } from "@prisma/client";

/**
 * The accounts a workspace can post to: Postiz's channel list, mirrored into
 * `channel_connections` (2026-09-29, master plan §6.7).
 *
 * Postiz owns the connection - the OAuth, the tokens, their refresh. Aksharo
 * keeps a row per channel with the external id and what the page shows (name,
 * handle, picture), which is what a post refers to and what keeps a post's
 * history readable after the account is gone. The row is written on read:
 * whenever the list is asked for, new channels get a row, changed ones are
 * updated, and a channel no longer in Postiz is marked `disconnected` rather
 * than deleted.
 *
 * The list itself is cached for {@link CHANNEL_CACHE_MS}: the run page asks for
 * it every time the dialog opens, and the dispatcher once per post.
 */
export interface DirectoryChannel {
  readonly view: ChannelView;
  readonly integration: PostizIntegration;
  /** Our row, for a channel Aksharo posts to. */
  readonly connection: ChannelConnection | null;
  readonly provider: SupportedProvider | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/** Only an HTTPS picture is shown: the page is served over HTTPS. */
function httpsOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** `linkedin-page` → `Linkedin page`, for a channel Aksharo does not know. */
function platformName(identifier: string): string {
  const words = identifier.replace(/[-_]+/g, " ").trim();
  return words === "" ? "Other" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

@Injectable()
export class ChannelDirectory {
  private cache: { readonly at: number; readonly list: PostizIntegration[] } | null = null;
  private inflight: Promise<PostizIntegration[]> | null = null;

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly postiz: PostizClient,
  ) {}

  /** Postiz's channels, at most {@link CHANNEL_CACHE_MS} old; one request at a time. */
  async integrations(options: { readonly fresh?: boolean } = {}): Promise<PostizIntegration[]> {
    const cached = this.cache;
    if (options.fresh !== true && cached !== null && this.now() - cached.at < CHANNEL_CACHE_MS) {
      return cached.list;
    }
    if (this.inflight !== null) return this.inflight;
    const request = this.postiz
      .listIntegrations()
      .then((list) => {
        this.cache = { at: this.now(), list };
        return list;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = request;
    return request;
  }

  /** One channel as Postiz has it now, by its Postiz id; null when it is gone. */
  async integration(externalId: string): Promise<PostizIntegration | null> {
    return (await this.integrations()).find((entry) => entry.id === externalId) ?? null;
  }

  /**
   * The workspace's channels, in Postiz's order, each with its row. TikTok
   * channels read as not available unless `tiktok` (its own flag) is on.
   */
  async sync(
    workspaceId: string,
    options: { readonly tiktok: boolean },
  ): Promise<DirectoryChannel[]> {
    const list = await this.integrations();
    const existing = await this.prisma.channelConnection.findMany({ where: { workspaceId } });
    const byExternal = new Map(existing.map((row) => [row.externalIntegrationId, row]));
    const channels: DirectoryChannel[] = [];

    for (const integration of list) {
      const canonical = canonicalProviderOf(integration.identifier);
      const provider = canonical !== null && isSupportedProvider(canonical) ? canonical : null;
      const name =
        (integration.name ?? "").trim() || (integration.profile ?? "").trim() || "Account";
      const username = (integration.profile ?? "").trim() || null;
      const avatarUrl = httpsOrNull(integration.picture);
      const disabled = integration.disabled === true;

      if (provider === null) {
        channels.push({
          integration,
          connection: null,
          provider: null,
          view: {
            id: null,
            provider: null,
            platform: platformName(integration.identifier),
            name,
            username,
            avatarUrl,
            supported: false,
            disabled,
            note: "Posting here from Aksharo is not available yet.",
          },
        });
        continue;
      }

      const connection = await this.upsert(
        workspaceId,
        integration,
        byExternal.get(integration.id),
        {
          provider,
          displayName: name,
          username,
          avatarUrl,
          connectionStatus: disabled ? "attention" : "connected",
        },
      );
      const tiktokOff = provider === "tiktok" && !options.tiktok;
      channels.push({
        integration,
        connection,
        provider,
        view: {
          id: connection.id,
          provider,
          platform: rulesFor(provider).label,
          name,
          username,
          avatarUrl,
          supported: true,
          disabled,
          note: disabled
            ? "This account is paused where it was connected."
            : tiktokOff
              ? "Posting to TikTok is not switched on yet."
              : null,
        },
      });
    }

    const live = new Set(list.map((entry) => entry.id));
    const gone = existing.filter(
      (row) => !live.has(row.externalIntegrationId) && row.connectionStatus !== "disconnected",
    );
    if (gone.length > 0) {
      await this.prisma.channelConnection.updateMany({
        where: { id: { in: gone.map((row) => row.id) }, workspaceId },
        data: { connectionStatus: "disconnected" },
      });
    }
    return channels;
  }

  private async upsert(
    workspaceId: string,
    integration: PostizIntegration,
    row: ChannelConnection | undefined,
    data: {
      readonly provider: SupportedProvider;
      readonly displayName: string;
      readonly username: string | null;
      readonly avatarUrl: string | null;
      readonly connectionStatus: "connected" | "attention";
    },
  ): Promise<ChannelConnection> {
    const verifiedAt = new Date(this.now());
    if (row === undefined) {
      try {
        return await this.prisma.channelConnection.create({
          data: {
            id: ulid(),
            workspaceId,
            externalIntegrationId: integration.id,
            lastVerifiedAt: verifiedAt,
            ...data,
          },
        });
      } catch (error) {
        // Two reads of the list at once: the other one created it.
        if (!isUniqueViolation(error)) throw error;
        const created = await this.prisma.channelConnection.findFirst({
          where: { workspaceId, externalIntegrationId: integration.id },
        });
        if (created === null) throw error;
        return created;
      }
    }
    const changed =
      row.provider !== data.provider ||
      row.displayName !== data.displayName ||
      row.username !== data.username ||
      row.avatarUrl !== data.avatarUrl ||
      row.connectionStatus !== data.connectionStatus;
    if (!changed) return row;
    return this.prisma.channelConnection.update({
      where: { id: row.id },
      data: { ...data, lastVerifiedAt: verifiedAt },
    });
  }
}

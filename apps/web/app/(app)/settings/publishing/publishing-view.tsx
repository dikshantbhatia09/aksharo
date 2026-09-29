"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import * as React from "react";

import { useWorkspaceId } from "@montaj/api-client";
import { Badge, Button, Card, Skeleton } from "@montaj/ui";

import {
  publishingKeys,
  usePublishingChannels,
  usePublishingStatus,
  type PublishChannel,
} from "@/components/repurpose/publishing/use-publishing";
import { INLINE_LINK_CLASS, SettingsGroup, SettingsSection } from "@/components/settings/section";

/**
 * Settings → Publishing (2026-09-29): whether this workspace can post clips to
 * social accounts, which accounts it posts as, and how to connect them.
 *
 * The accounts themselves are connected in Postiz, the open-source scheduler
 * that runs beside Aksharo and keeps each platform's sign-in; Aksharo holds
 * no social account's password or token, only Postiz's key. This is the owner's
 * page, so unlike the run page it names Postiz: it is where the setup happens.
 * The long version is `docs/publishing/POSTIZ-SETUP.md`.
 */

function AccountRow({ channel }: { readonly channel: PublishChannel }): React.JSX.Element {
  return (
    <li
      className="flex items-center gap-3 py-2"
      data-testid={`publishing-account-${channel.platform}`}
    >
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-2 text-xs font-medium text-fg-1"
      >
        {channel.avatarUrl === null ? (
          (channel.name.trim().charAt(0) || "?").toUpperCase()
        ) : (
          <img src={channel.avatarUrl} alt="" className="size-full object-cover" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-fg-0">
          {channel.name}
          {channel.username === null || channel.username === channel.name ? null : (
            <>
              {" "}
              <span className="text-fg-2">@{channel.username}</span>
            </>
          )}
        </span>
        <span className="block text-xs text-fg-2">{channel.note ?? channel.platform}</span>
      </span>
      {channel.supported && channel.note === null ? (
        <Badge tone="accepted">{channel.platform}</Badge>
      ) : (
        <Badge tone="neutral">{channel.platform}</Badge>
      )}
    </li>
  );
}

export function PublishingView(): React.JSX.Element {
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const { status, loading } = usePublishingStatus();
  const channels = usePublishingChannels(status.enabled);
  const postizUrl = status.postizUrl ?? "http://localhost:4007";

  return (
    <SettingsSection
      title="Publishing"
      description="Post clips to Instagram, YouTube, LinkedIn, X, Facebook, Threads and TikTok from Aksharo."
      testId="settings-publishing"
    >
      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : !status.enabled ? (
        <Card data-testid="publishing-off">
          <p className="m-0 text-sm text-fg-1">
            Posting to social accounts is not switched on for this workspace yet. Every clip can
            still be downloaded and posted by hand.
          </p>
        </Card>
      ) : (
        <>
          <Card className="flex flex-col gap-3" data-testid="publishing-status">
            {status.available ? (
              <p className="m-0 text-sm text-fg-0">
                Ready.{" "}
                {status.channelCount === 1
                  ? "1 account"
                  : `${String(status.channelCount)} accounts`}{" "}
                can be posted to. Use Post on any finished clip.
              </p>
            ) : (
              <p className="m-0 text-sm text-fg-0" data-testid="publishing-missing">
                {status.message ?? "Posting is not set up yet."}
              </p>
            )}
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (workspaceId === null) return;
                  void queryClient.invalidateQueries({ queryKey: publishingKeys.all(workspaceId) });
                }}
                data-testid="publishing-check-again"
              >
                Check again
              </Button>
            </div>
          </Card>

          {channels.data === undefined || channels.data.channels.length === 0 ? null : (
            <SettingsGroup
              title="Accounts"
              description="Connected in Postiz. Aksharo posts as these."
              testId="publishing-accounts"
            >
              <Card className="py-2">
                <ul className="m-0 list-none divide-y divide-border p-0">
                  {channels.data.channels.map((channel) => (
                    <AccountRow
                      key={`${channel.platform}-${channel.name}-${channel.id ?? ""}`}
                      channel={channel}
                    />
                  ))}
                </ul>
              </Card>
            </SettingsGroup>
          )}

          <SettingsGroup
            title="How to set it up"
            description="Your accounts are connected in Postiz, which runs beside Aksharo and keeps each platform's sign-in. Aksharo never sees those passwords."
            testId="publishing-setup"
          >
            <Card>
              <ol className="m-0 flex list-decimal flex-col gap-3 pl-5 text-sm text-fg-1">
                <li>
                  Open{" "}
                  <a
                    href={postizUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={INLINE_LINK_CLASS}
                    data-testid="publishing-postiz-link"
                  >
                    Postiz
                    <ExternalLink
                      className="ml-1 inline size-3.5"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                  </a>{" "}
                  ({postizUrl}) and sign in.
                </li>
                <li>
                  Add each account with <span className="text-fg-0">Add channel</span>. Each
                  platform first needs its own developer app set up on the Postiz server; the steps
                  are in{" "}
                  <span className="font-mono text-xs text-fg-0">
                    docs/publishing/POSTIZ-SETUP.md
                  </span>
                  .
                </li>
                <li>
                  In Postiz, open <span className="text-fg-0">Settings, Developers</span> and copy
                  the Public API key.
                </li>
                <li>
                  Put it in the API&apos;s environment as{" "}
                  <span className="font-mono text-xs text-fg-0">POSTIZ_API_KEY</span>, with{" "}
                  <span className="font-mono text-xs text-fg-0">POSTIZ_WORKSPACE_IDS</span> set to
                  this workspace (
                  <span className="font-mono text-xs text-fg-0">{workspaceId ?? "…"}</span>
                  ), and restart the API.
                </li>
                <li>Come back here and press Check again: your accounts appear above.</li>
              </ol>
            </Card>
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  );
}

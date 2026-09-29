"use client";

/**
 * The bell (2026-09-29): what the platform told this person, newest first,
 * with a dot while any of it is unread.
 *
 * The API has kept these rows since A25 (`GET /me/notifications`); nothing
 * showed them. Clips runs now write four kinds here — clips ready, everything
 * ready, a run that stopped, a run that needs you — and each opens its run.
 *
 * Kept fresh two ways: a minute's poll, and the shell refetching the moment a
 * `notification.created` for this person arrives on the socket
 * (`app-shell.tsx`). Opening a row marks it read.
 *
 * Accent budget (DESIGN.md): the unread dots are the only accent here. The
 * row markers use the signal colours, as the stage rail does.
 */
import { AlertTriangle, Bell, CheckCircle2, CircleDot, Hand } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useMarkNotificationRead, useNotifications } from "@montaj/api-client";
import type { NotificationItem } from "@montaj/api-client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@montaj/ui";

import { notificationText, relativeTime, type NotificationTone } from "./notification-copy";

import { useRuntimeConfig } from "@/components/providers";
import { useLocale, useT } from "@/lib/i18n/locale-provider";

const TONE_ICON: Readonly<Record<NotificationTone, React.ComponentType<{ className?: string }>>> =
  Object.freeze({
    done: CheckCircle2,
    stopped: AlertTriangle,
    yours: Hand,
    neutral: CircleDot,
  });

const TONE_CLASS: Readonly<Record<NotificationTone, string>> = Object.freeze({
  done: "text-accepted",
  stopped: "text-rejected",
  yours: "text-warning",
  neutral: "text-fg-2",
});

export function NotificationBell(): React.JSX.Element {
  const t = useT();
  const [locale] = useLocale();
  const router = useRouter();
  const config = useRuntimeConfig();
  const query = useNotifications({ limit: 10 });
  const markRead = useMarkNotificationRead();
  const unread = query.data?.unread ?? 0;
  const items = query.data?.items ?? [];

  const open = (item: NotificationItem, href: string | null): void => {
    if (item.readAt === null) markRead.mutate(item.id);
    if (href !== null) router.push(href);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            unread > 0
              ? t("notifications.labelUnread", { count: unread })
              : t("notifications.label")
          }
          data-testid="notification-bell"
        >
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="bg-accent absolute top-1.5 right-1.5 size-2 rounded-full"
              data-testid="notification-unread-dot"
            />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80" data-testid="notification-list">
        <DropdownMenuLabel>{t("notifications.heading")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="text-fg-2 m-0 px-2.5 py-3 text-xs" data-testid="notification-empty">
            {t("notifications.empty")}
          </p>
        ) : (
          items.map((item) => {
            const copy = notificationText(item, t, config.webOrigin);
            const Icon = TONE_ICON[copy.tone];
            const isUnread = item.readAt === null;
            return (
              <DropdownMenuItem
                key={item.id}
                className="items-start gap-2.5 py-2"
                onSelect={() => {
                  open(item, copy.href);
                }}
                data-testid={`notification-${item.id}`}
                data-kind={item.kind}
                data-unread={isUnread ? "true" : "false"}
              >
                <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_CLASS[copy.tone])} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-fg-0 text-sm font-medium">{copy.title}</span>
                  <span className="text-fg-1 text-xs">{copy.body}</span>
                  <span className="text-fg-2 text-2xs">{relativeTime(item.createdAt, locale)}</span>
                </span>
                {isUnread ? (
                  <span className="mt-1.5 flex shrink-0 items-center">
                    <span aria-hidden="true" className="bg-accent size-1.5 rounded-full" />
                    <span className="sr-only">{t("notifications.unread")}</span>
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/notifications" data-testid="notification-settings">
            {t("notifications.settings")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { useQueries } from "@tanstack/react-query";
import { ArrowUpRight, HardDrive, Monitor } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import {
  endpoints,
  isApiError,
  useApiClient,
  useEntitlement,
  useProjects,
  useWorkspaceId,
} from "@montaj/api-client";
import { BRAND, surfaceEnabled } from "@montaj/config";
import { Badge, Button, cn, Tooltip, TooltipContent, TooltipTrigger } from "@montaj/ui";

import { BrandMark } from "./brand-mark";
import { CreditsCard } from "./credits-card";
import { ProfileMenu } from "./profile-menu";
import { useNavItems } from "./use-nav-targets";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { fontEndpoints, type WorkspaceFontView } from "../editor/rail/fonts-endpoints";

import type { NavItem } from "@/lib/nav";

import { useRuntimeConfig } from "@/components/providers";
import { StreakChip } from "@/components/streak/streak-chip";
import { isActivePath } from "@/lib/nav";

/**
 * K04: Storage used, best-effort and bounded.
 *
 * No workspace-wide storage aggregate exists anywhere server-side (checked
 * `apps/api/prisma/schema.prisma`: no `storageBytes`/`totalBytes` on
 * `Workspace`/`Plan`/`Entitlement`; `projectSchema` carries `mediaCount` but
 * no bytes). Computing an exhaustive total would mean paging through every
 * project and every project's media on every sidebar render — an unbounded
 * fan-out this shell should not be doing. This sums bytes across the
 * workspace's most recently active `PROJECT_SAMPLE_LIMIT` projects' media
 * plus its custom fonts (all real numbers, all from endpoints that already
 * exist) and says so via the row's tooltip — correct outright for any
 * workspace with fewer projects than the sample, an honest estimate beyond
 * that. A server-side running total (incremented alongside upload/delete,
 * the way `CreditAccount.balanceTenths` is) is the real fix and is flagged as
 * a follow-up in the work package's report rather than improvised here.
 */
const PROJECT_SAMPLE_LIMIT = 20;

export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb % 1 === 0 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Pure so the summing rule is unit-testable without mounting the sidebar's network hooks. */
export function sumStorageBytes(
  media: readonly { readonly sizeBytes: number | null }[],
  fonts: readonly WorkspaceFontView[],
): number {
  const mediaBytes = media.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  const fontBytes = fonts.reduce(
    (sum, font) => sum + (font.sizeBytes ?? 0) + (font.woff2SizeBytes ?? 0),
    0,
  );
  return mediaBytes + fontBytes;
}

function useStorageUsage(): { bytes: number; sampled: boolean; loading: boolean } {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const projects = useProjects({ limit: PROJECT_SAMPLE_LIMIT });
  const projectIds = projects.data?.pages[0]?.items.map((project) => project.id) ?? [];

  const mediaQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["ws", workspaceId ?? "none", "projects", projectId, "media", "storage-sum"],
      enabled: workspaceId !== null,
      retry: (failureCount: number, error: Error) =>
        !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2,
      queryFn: () => client.call(endpoints.media.list, { params: { projectId } }),
    })),
  });

  const fontsQuery = useQueries({
    queries: [
      {
        queryKey: ["ws", workspaceId ?? "none", "fonts"],
        enabled: workspaceId !== null,
        retry: false,
        queryFn: () => client.call(fontEndpoints.list, { params: { id: workspaceId ?? "" } }),
      },
    ],
  })[0];

  const media = mediaQueries.flatMap((query) => query.data ?? []);
  const fonts = fontsQuery?.data ?? [];
  const loading =
    projects.isPending ||
    mediaQueries.some((query) => query.isPending) ||
    fontsQuery?.isPending === true;

  return {
    bytes: sumStorageBytes(media, fonts),
    sampled: projectIds.length >= PROJECT_SAMPLE_LIMIT,
    loading,
  };
}

/** One row of the expanded sidebar, in the canvas's `barStyle`. */
function NavRow({
  item,
  badge,
  onNavigate,
}: {
  item: NavItem;
  badge?: string | undefined;
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  const pathname = usePathname() ?? "/";
  // A row nobody can click is never the current page, whatever the path
  // says: the Editor entry falls back to `/projects` while the workspace
  // is empty, and two accent-tinted rows is not a state the rail has.
  const active = item.ready && isActivePath(pathname, item.href);
  const Icon = item.icon;
  const classes = cn(
    "flex min-h-9 w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm",
    "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
    active ? "bg-accent/14 text-accent-200" : "text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
  );

  if (!item.ready) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="link"
            aria-disabled="true"
            tabIndex={0}
            data-testid={`nav-${item.key}`}
            className={cn(
              classes,
              "text-fg-disabled hover:text-fg-disabled cursor-default hover:bg-transparent",
            )}
          >
            <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            {item.label}
            <Badge className="ml-auto">{item.disabledBadge ?? "Soon"}</Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">
          {item.disabledNote ?? `${item.label} is on its way. Nothing to click yet.`}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      href={item.href}
      className={classes}
      aria-current={active ? "page" : undefined}
      data-testid={`nav-${item.key}`}
      onClick={onNavigate}
    >
      <Icon
        className={cn("size-4 shrink-0", active ? undefined : "text-fg-2")}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      {item.label}
      {badge === undefined ? null : (
        <span className="text-fg-2 ml-auto text-2xs tabular-nums">{badge}</span>
      )}
    </Link>
  );
}

/**
 * The canvas's 232 px sidebar: brand lockup over the eight primary
 * destinations, then the shipped routes the rail has no room for, then — at
 * the foot — the credit card and the profile row.
 *
 * The canvas shows a project count on Projects, and this shows the real one
 * from the project list the shell already holds, or nothing when it has not
 * loaded. A stale hard-coded "24" is worse than no badge.
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const config = useRuntimeConfig();
  const { primary, secondary } = useNavItems();
  const projects = useProjects({ limit: 8 });
  /*
   * The canvas puts a count on the Projects row. `ProjectPage` carries items
   * and a cursor but no total, so the only count this can state truthfully is
   * the one from a page that *is* the whole list. Past that the badge is
   * omitted rather than shown as a number that means "the first eight".
   */
  const firstPage = projects.data?.pages[0];
  const projectCount =
    firstPage !== undefined && firstPage.nextCursor === null ? firstPage.items.length : undefined;
  const isProductionOrigin = isBrandOrigin(config.webOrigin);
  const storage = useStorageUsage();
  // Two sidebars can be mounted at once (the desktop aside and the mobile
  // sheet), so the "More" heading's id must be unique per instance.
  const moreHeadingId = React.useId();

  return (
    <div className="bg-sunken scrollbar-thin flex h-full w-full flex-col gap-5 overflow-y-auto px-3 pt-4 pb-3.5 shadow-[inset_-1px_0_0_var(--color-border)]">
      {/*
        The lockup: one link home (mark + wordmark), then the workspace as its
        own control underneath. They are two controls, not one — a switcher
        nested inside the home link would be a button inside an anchor, which
        is invalid and unusable by keyboard. The switcher used to be a 10 px
        uppercase line under the wordmark: under the legibility floor and a
        ~14 px hit target for the one control that changes whose data you see.
      */}
      <div className="flex flex-col gap-2">
        <Link
          href="/"
          className="flex min-h-9 items-center gap-2.5 self-start rounded-sm px-1.5"
          onClick={onNavigate}
          data-testid="sidebar-brand"
          aria-label={`${BRAND.name} home`}
        >
          <BrandMark size={30} />
          <span aria-hidden="true" className="text-fg-0 text-base font-semibold">
            {BRAND.name}
          </span>
        </Link>
        <WorkspaceSwitcher />
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {primary.map((item) => (
          <NavRow
            key={item.key}
            item={item}
            badge={
              item.key === "projects" && projectCount !== undefined
                ? String(projectCount)
                : undefined
            }
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <nav aria-labelledby={moreHeadingId} className="flex flex-col gap-0.5">
        <span
          id={moreHeadingId}
          className="text-fg-2 px-2.5 pb-1 text-2xs font-medium tracking-[0.08em] uppercase"
        >
          More
        </span>
        {secondary.map((item) => (
          <NavRow key={item.key} item={item} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <CreditsCard />

        {/*
          K04: Storage alongside the credit card. Storage has no real balance
          to draw from (see `useStorageUsage`'s doc comment) so it is a
          sentence with a number, not a meter — the canvas has no bar for a
          quantity with no cap, and inventing a quota to fill one would be a
          made-up number on a real screen.
        */}
        <div className="px-1.5" data-testid="storage-meter-wrapper">
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                tabIndex={0}
                className="text-fg-2 flex min-h-8 items-center gap-2 rounded-sm px-1 text-2xs"
                data-testid="storage-meter"
              >
                <HardDrive className="size-3.5 shrink-0" aria-hidden="true" />
                <span>{storage.loading ? "…" : formatStorageBytes(storage.bytes)} of media</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right">
              {storage.sampled
                ? `Estimated from your most recently active ${PROJECT_SAMPLE_LIMIT} projects, plus your custom fonts.`
                : "Every project's media, plus your custom fonts."}
            </TooltipContent>
          </Tooltip>
        </div>

        <StreakChip />

        {/*
          Two gates, both of which have to be open.

          `isProductionOrigin`: aksharo.ai/download only exists for the
          production deployment, and offering it from a local or staging build
          sends people to a download that has nothing to do with the app they
          are using (F07-E8). `webOrigin` comes from the server on the same
          render, so this gates without a flash.

          `desktop.download`: the desktop app is not part of this release.
          `apps/desktop` is not in this Git HEAD at all — the release workflow
          that built it invokes a workspace that does not exist — so the link
          advertised a product nobody could get, from the sidebar of every
          signed-in user (launch-readiness P0-12). The flag is OFF unless
          FEATURE_FLAGS_JSON explicitly turns it on, which is the right default
          for a surface whose artefacts do not exist yet: turn it on in the same
          change that restores and signs the build.
        */}
        {isProductionOrigin && surfaceEnabled("desktop", config.flags) ? (
          <a
            href={`https://${BRAND.domain}/download`}
            className="text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0 flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-xs"
            data-testid="desktop-download"
          >
            <Monitor className="text-fg-2 size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>
              Get the desktop app
              <span className="text-fg-2 block">
                Local mode, watch folders, offline queue
              </span>
            </span>
          </a>
        ) : null}

        <ProfileMenu onNavigate={onNavigate} />
      </div>
    </div>
  );
}

/** True when `origin` is the brand's own production host (`aksharo.ai`). */
function isBrandOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === BRAND.domain || host.endsWith(`.${BRAND.domain}`);
  } catch {
    return false;
  }
}

/**
 * The "Upgrade" call to action, hidden on the top plan (08 §3).
 *
 * Secondary, not primary: it sits in global chrome above every page, and each
 * page's own header already spends the screen's one filled primary on its main
 * task (DESIGN.md "Accent budget"; HIG Toolbars › Actions — one prominent
 * action). An upsell that out-shouts "Export video" is the wrong hierarchy.
 */
export function UpgradeButton({
  editor = false,
}: { editor?: boolean } = {}): React.JSX.Element | null {
  const { razorpayEnabled } = useRuntimeConfig();
  const entitlement = useEntitlement();
  const plan = entitlement.data?.planKey;
  // No payment rail, no purchase CTA: /billing would only say "payments are not
  // configured". Credits arrive through the admin grant in this build.
  if (!razorpayEnabled) return null;
  if (plan === undefined || plan === "studio" || plan === "agency") return null;
  return (
    <Button variant="secondary" size="sm" asChild data-testid="upgrade-cta">
      <Link href="/billing" className={editor ? "editor-upgrade" : undefined}>
        Upgrade{editor ? <ArrowUpRight className="size-[13px]" aria-hidden="true" /> : null}
      </Link>
    </Button>
  );
}

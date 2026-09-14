"use client";

import { useQueries } from "@tanstack/react-query";
import { ArrowUpRight, AudioLines, HardDrive, Monitor } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import {
  endpoints,
  isApiError,
  useApiClient,
  useEntitlement,
  useProjects,
  useWorkspaceCredits,
  useWorkspaceId,
} from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import {
  Badge,
  Button,
  cn,
  CreditMeter,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@montaj/ui";

import { ProfileMenu } from "./profile-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { fontEndpoints, type WorkspaceFontView } from "../editor/rail/fonts-endpoints";

import { useRuntimeConfig } from "@/components/providers";
import { StreakChip } from "@/components/streak/streak-chip";
import { isActivePath, PRIMARY_NAV } from "@/lib/nav";

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

/**
 * The sidebar of 08 §3.
 *
 * It is a `<nav>` with a list, so a screen reader can jump the whole block and
 * count the items, and the active item is marked with `aria-current="page"`
 * rather than colour alone.
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const pathname = usePathname();
  const config = useRuntimeConfig();
  const entitlement = useEntitlement();
  const credits = useWorkspaceCredits();
  const included = entitlement.data?.creditsPerMonthTenths ?? 0;
  const isProductionOrigin = isBrandOrigin(config.webOrigin);
  const storage = useStorageUsage();

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-2 pt-1">
        <Link
          href="/"
          className="text-fg-0 rounded-sm font-display text-lg font-semibold tracking-tight"
          onClick={onNavigate}
        >
          {BRAND.name}
        </Link>
      </div>

      <WorkspaceSwitcher />

      <nav aria-label="Main" className="flex-1">
        <ul className="flex flex-col gap-0.5">
          {PRIMARY_NAV.map((item) => {
            const active = isActivePath(pathname, item.href);
            const Icon = item.icon;
            const classes = cn(
              "flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm font-medium",
              "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
              active ? "bg-bg-2 text-lime-500" : "text-fg-1 hover:bg-bg-2 hover:text-fg-0",
            );

            if (!item.ready) {
              return (
                <li key={item.key}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        aria-disabled="true"
                        data-testid={`nav-${item.key}`}
                        className={cn(
                          classes,
                          "text-fg-disabled cursor-default hover:bg-transparent",
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {item.label}
                        <Badge className="ml-auto">Soon</Badge>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {item.label} is on its way. Nothing to click yet.
                    </TooltipContent>
                  </Tooltip>
                </li>
              );
            }

            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className={classes}
                  aria-current={active ? "page" : undefined}
                  data-testid={`nav-${item.key}`}
                  onClick={onNavigate}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-border flex flex-col gap-3 border-t pt-3">
        <div className="px-2">
          {/*
            The entitlement carries the plan's monthly **allowance** (A05); the
            live balance and lots come from B02's real credit ledger
            (`GET /workspaces/{id}/credits`). Burn rate and streak are not
            computed by that endpoint yet, so the tooltip/streak badge stay
            off rather than inventing numbers.
          */}
          <CreditMeter
            remainingTenths={credits.data?.balanceTenths ?? included}
            includedTenths={credits.data?.monthlyGrantTenths ?? included}
            {...(credits.data?.grantResetAt == null ? {} : { resetsAt: credits.data.grantResetAt })}
            showStreak={config.flags["growth.streakWidget"] === true}
          />
        </div>

        {/*
          K04: Storage and Audio-Clean-credits, alongside the transcription
          meter above (README recon §1 — Kalakar's sidebar shows all three,
          ours showed only one). Audio Clean draws from the SAME credit
          ledger as transcription (`packages/config/src/credits.ts`:
          `audioClean` costs exactly 1 credit per media minute, the identical
          rate `transcribe` uses) — this app has one unified credit pool, not
          a separate audio-clean balance, so relabelling the same numbers is
          the honest answer, not a second (fictional) balance. Storage has no
          real balance to draw from at all (see `useStorageUsage`'s doc
          comment) — its meter shows a bytes figure with the bar and reset
          row hidden rather than inventing a quota.
        */}
        <div className="px-2">
          <CreditMeter
            testId="audio-clean-meter"
            label="Audio Clean"
            icon={AudioLines}
            remainingTenths={credits.data?.balanceTenths ?? included}
            includedTenths={credits.data?.monthlyGrantTenths ?? included}
            valueSuffix="left"
            formatUnit={(tenths) => `≈ ${(tenths / 10).toFixed(1)} min of audio clean`}
            {...(credits.data?.grantResetAt == null ? {} : { resetsAt: credits.data.grantResetAt })}
          />
        </div>

        <div className="px-2" data-testid="storage-meter-wrapper">
          {storage.sampled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div tabIndex={0}>
                  <CreditMeter
                    testId="storage-meter"
                    label="Storage"
                    icon={HardDrive}
                    remainingTenths={storage.bytes}
                    includedTenths={storage.bytes}
                    formatValue={() => (storage.loading ? "…" : formatStorageBytes(storage.bytes))}
                    valueSuffix="used"
                    formatUnit={null}
                    showProgress={false}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">
                Estimated from your most recently active {PROJECT_SAMPLE_LIMIT} projects, plus your
                custom fonts.
              </TooltipContent>
            </Tooltip>
          ) : (
            <CreditMeter
              testId="storage-meter"
              label="Storage"
              icon={HardDrive}
              remainingTenths={storage.bytes}
              includedTenths={storage.bytes}
              formatValue={() => (storage.loading ? "…" : formatStorageBytes(storage.bytes))}
              valueSuffix="used"
              formatUnit={null}
              showProgress={false}
            />
          )}
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
        {isProductionOrigin && config.flags["desktop.download"] === true ? (
          <a
            href={`https://${BRAND.domain}/download`}
            className="text-fg-1 hover:bg-bg-2 hover:text-fg-0 mx-1 flex items-center gap-2.5 rounded-sm px-2 py-2 text-xs"
            data-testid="desktop-download"
          >
            <Monitor className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Get the desktop app
              <span className="text-fg-2 block">Local mode, watch folders, offline queue</span>
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

/** The "Upgrade" call to action, hidden on the top plan (08 §3). */
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
    <Button variant="primary" size="sm" asChild data-testid="upgrade-cta">
      <Link href="/billing" className={editor ? "editor-upgrade" : undefined}>
        Upgrade{editor ? <ArrowUpRight className="size-[13px]" aria-hidden="true" /> : null}
      </Link>
    </Button>
  );
}

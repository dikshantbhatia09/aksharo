"use client";

import { Monitor } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { useEntitlement, useUsage } from "@montaj/api-client";
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

import { useRuntimeConfig } from "@/components/providers";
import { isActivePath, PRIMARY_NAV } from "@/lib/nav";

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
  const usage = useUsage();

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
          <CreditMeter
            remainingTenths={entitlement.data?.creditsRemainingTenths ?? 0}
            includedTenths={entitlement.data?.creditsIncludedTenths ?? 0}
            {...(entitlement.data?.resetsAt == null ? {} : { resetsAt: entitlement.data.resetsAt })}
            {...(usage.data === null || usage.data === undefined
              ? {}
              : {
                  burnRateTenthsPerDay: usage.data.burnRateTenthsPerDay,
                  streakDays: usage.data.streakDays,
                })}
            showStreak={config.flags["growth.streakWidget"] === true}
          />
        </div>

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

        <ProfileMenu onNavigate={onNavigate} />
      </div>
    </div>
  );
}

/** The "Upgrade" call to action, hidden on the top plan (08 §3). */
export function UpgradeButton(): React.JSX.Element | null {
  const entitlement = useEntitlement();
  const plan = entitlement.data?.plan;
  if (plan === undefined || plan === "studio" || plan === "agency") return null;
  return (
    <Button variant="primary" size="sm" asChild data-testid="upgrade-cta">
      <Link href="/billing">Upgrade</Link>
    </Button>
  );
}

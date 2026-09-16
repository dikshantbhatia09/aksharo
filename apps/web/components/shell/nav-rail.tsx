"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { useWorkspaceCredits, useEntitlement } from "@montaj/api-client";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@montaj/ui";

import { BrandMark } from "./brand-mark";
import { ProfileMenu } from "./profile-menu";
import { useNavItems } from "./use-nav-targets";

import { StreakChip } from "@/components/streak/streak-chip";
import { isActivePath } from "@/lib/nav";

/**
 * The canvas's 68 px icon rail — the shell's default width.
 *
 * Eight destinations, each a 56 px square carrying a 19 px icon over a 9 px
 * caption; the brand mark at the top, and at the bottom the credit balance as
 * a bolt and a number, then the avatar. Nothing else fits, and the canvas puts
 * nothing else there: {@link SECONDARY_NAV} is the expanded sidebar's alone.
 *
 * The active item is an accent tint with a 1 px inset accent ring, and carries
 * `aria-current="page"` — colour is never the only signal (08 §6).
 */
export function NavRail(): React.JSX.Element {
  const pathname = usePathname() ?? "/";
  const { primary } = useNavItems();
  const credits = useWorkspaceCredits();
  const entitlement = useEntitlement();
  const balance =
    credits.data?.balanceTenths ?? entitlement.data?.creditsPerMonthTenths ?? undefined;

  return (
    <div
      className="bg-sunken flex h-full w-[68px] flex-col items-center gap-[3px] py-3 shadow-[inset_-1px_0_0_var(--color-neutral-900)]"
      data-testid="nav-rail"
    >
      <Link href="/" aria-label="Aksharo home" className="mb-3 rounded-sm">
        <BrandMark size={32} />
      </Link>

      <nav aria-label="Main" className="flex w-full flex-col items-center gap-[3px]">
        {primary.map((item) => {
          // A row nobody can click is never the current page, whatever the path
          // says: the Editor entry falls back to `/projects` while the workspace
          // is empty, and two accent-tinted rows is not a state the rail has.
          const active = item.ready && isActivePath(pathname, item.href);
          const Icon = item.icon;
          const classes = cn(
            "flex w-14 flex-col items-center gap-[5px] rounded-sm px-0 pt-2 pb-[7px]",
            "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
            active
              ? "bg-accent/16 text-accent-200 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
              : "text-neutral-500 hover:bg-neutral-100/6 hover:text-neutral-300",
          );

          if (!item.ready) {
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <span
                    aria-disabled="true"
                    data-testid={`nav-${item.key}`}
                    className={cn(classes, "text-fg-disabled cursor-default hover:bg-transparent")}
                  >
                    <Icon className="size-[19px] shrink-0" aria-hidden="true" />
                    <span className="text-[9px] tracking-[0.02em]">{item.short}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {item.disabledNote ?? `${item.label} is on its way. Nothing to click yet.`}
                </TooltipContent>
              </Tooltip>
            );
          }

          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>
                <Link
                  href={item.href}
                  className={classes}
                  aria-current={active ? "page" : undefined}
                  data-testid={`nav-${item.key}`}
                >
                  <Icon className="size-[19px] shrink-0" aria-hidden="true" />
                  <span className="text-[9px] tracking-[0.02em]">{item.short}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2.5 pt-3">
        {/*
          `growth.streakWidget` is ON in production, so the chip was live on
          every screen until the rail became the default shell. It renders
          nothing when the flag is off, the user is ineligible, or they are in
          the holdout arm (B06), so this costs nothing when it is not wanted.
        */}
        <div className="max-w-full [&_[data-testid=streak-chip]]:px-0 [&_[data-testid=streak-chip]]:text-[9px]">
          <StreakChip />
        </div>

        <Link
          href="/billing"
          className="text-neutral-400 hover:text-neutral-200 flex flex-col items-center gap-0.5 rounded-sm"
          data-testid="rail-credits"
        >
          {/* The bolt is the canvas's ph-lightning; Lucide's Zap is the same mark. */}
          <svg
            viewBox="0 0 24 24"
            className="text-accent size-[15px]"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M13.5 2 4 13.5h6L10.5 22 20 10.5h-6L13.5 2Z" />
          </svg>
          <span className="text-[10px] tabular-nums">
            {balance === undefined ? "—" : Math.round(balance / 10)}
          </span>
          <span className="sr-only">credits left</span>
        </Link>

        <ProfileMenu compact />
      </div>
    </div>
  );
}

"use client";

import { Menu, Plus, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { Button, cn, ShortcutHint, shortcutKeys, Sheet, SheetContent, SheetTitle } from "@montaj/ui";

import { screenTitleFor } from "./screen-title";
import { Sidebar, UpgradeButton } from "./sidebar";

import type { NavModel } from "./nav-model";

/**
 * The canvas's 52 px header.
 *
 * Left: where you are, in two lines — a 9.5 px uppercase breadcrumb over a
 * 15 px title. Right: the Rail/Sidebar switch that sets the shell's width,
 * then search, New project, What's new and Upgrade. The bottom edge is a rule
 * that fades out 48 px from each end rather than stopping at the corners —
 * Nocturne's signature, and the reason this is a background gradient instead
 * of a `border-b`.
 *
 * On a narrow viewport the nav collapses into a sheet that this bar opens,
 * which is why the mobile trigger lives here rather than in the sidebar.
 */
export function TopBar({
  onOpenPalette,
  hasWhatsNew = false,
  navModel,
  onNavModelChange,
}: {
  onOpenPalette: () => void;
  hasWhatsNew?: boolean;
  navModel: NavModel;
  onNavModelChange: (next: NavModel) => void;
}): React.JSX.Element {
  const [navOpen, setNavOpen] = React.useState(false);
  const [keys, setKeys] = React.useState<readonly string[]>(["Ctrl", "K"]);
  const pathname = usePathname();
  const { crumb, title } = screenTitleFor(pathname);

  // The modifier glyph depends on the platform, which only the browser knows;
  // reading it during render would make the server and client markup disagree.
  React.useEffect(() => {
    setKeys(shortcutKeys(["Ctrl", "K"]));
  }, []);

  const segment = (on: boolean): string =>
    cn(
      "rounded-[6px] px-2.5 py-1 text-[11.5px] transition-colors duration-[160ms]",
      on ? "bg-accent/16 text-accent-200" : "text-neutral-500 hover:text-neutral-300",
    );

  return (
    <header className="bg-bg-0/95 rule-fade-b sticky top-0 z-30 flex h-[52px] items-center gap-3.5 px-4 backdrop-blur">
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          data-testid="open-nav"
          onClick={() => {
            setNavOpen(true);
          }}
        >
          <Menu aria-hidden="true" />
        </Button>
        <SheetContent side="left" className="p-0" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar
            onNavigate={() => {
              setNavOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>

      <span className="flex min-w-0 flex-col leading-[1.2]" data-testid="screen-title">
        <span className="text-neutral-500 text-[9.5px] tracking-[0.12em] uppercase">{crumb}</span>
        <span className="font-display truncate text-[15px] font-medium tracking-[-0.01em]">
          {title}
        </span>
      </span>

      <div className="ml-auto flex items-center gap-2.5">
        {/*
          The canvas ships the shell in two widths and lets the reader switch
          between them from here. It is a real preference, remembered per
          browser (`useNavModel`), and there is nothing below `lg` to switch —
          both widths collapse into the same sheet.
        */}
        <span
          className="border-border hidden items-center gap-1.5 rounded-sm border p-[3px] lg:flex"
          data-testid="nav-model-switch"
        >
          <span className="text-neutral-500 pl-1.5 text-[9.5px] tracking-[0.1em] uppercase">
            Nav
          </span>
          <button
            type="button"
            className={segment(navModel === "rail")}
            aria-pressed={navModel === "rail"}
            onClick={() => {
              onNavModelChange("rail");
            }}
            data-testid="nav-model-rail"
          >
            Rail
          </button>
          <button
            type="button"
            className={segment(navModel === "sidebar")}
            aria-pressed={navModel === "sidebar"}
            onClick={() => {
              onNavModelChange("sidebar");
            }}
            data-testid="nav-model-sidebar"
          >
            Sidebar
          </button>
        </span>

        <button
          type="button"
          onClick={onOpenPalette}
          data-testid="open-palette"
          className="border-border bg-surface text-neutral-500 hover:border-accent hidden h-[30px] w-56 items-center gap-2 rounded-sm border px-2.5 text-[12.5px] transition-colors md:flex"
        >
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Search projects and actions</span>
          <ShortcutHint keys={keys} />
        </button>

        <Button variant="secondary" size="sm" asChild data-testid="new-project">
          <Link href="/?new=1">
            <Plus aria-hidden="true" />
            <span className="hidden sm:inline">New project</span>
          </Link>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          asChild
          aria-label={hasWhatsNew ? "What's new (unread)" : "What's new"}
          data-testid="whats-new"
        >
          <Link href="/updates" className="relative">
            <Sparkles aria-hidden="true" />
            {hasWhatsNew ? (
              <span
                aria-hidden="true"
                className="bg-accent absolute top-1.5 right-1.5 size-2 rounded-full"
              />
            ) : null}
          </Link>
        </Button>

        <UpgradeButton />
      </div>
    </header>
  );
}

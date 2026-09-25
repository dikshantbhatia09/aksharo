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
 * The 52 px header: global chrome, not page content.
 *
 * Left: the section you are in, in the nav's own words (the page's title
 * lives in its `PageHeader`, so this is one quiet line, never the display
 * face). Right: the Rail/Sidebar width switch, search, New project, What's new
 * and Upgrade — all secondary or ghost, because each page's header spends the
 * screen's one filled primary on its own main task (DESIGN.md "Accent
 * budget"; HIG Toolbars › Actions).
 *
 * On a narrow viewport the nav collapses into a sheet that this bar opens,
 * which is why the mobile trigger lives here rather than in the sidebar, and
 * search collapses to an icon button rather than disappearing.
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
      "inline-flex h-8 items-center rounded-sm px-2.5 text-xs font-medium transition-colors duration-[160ms]",
      // A segmented control's selection is neutral: the accent is already spent
      // on the active nav row, and two accent "you are here" marks compete.
      on ? "bg-bg-2 text-fg-0" : "text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0",
    );

  return (
    <header className="bg-bg-0/95 rule-fade-b sticky top-0 z-30 flex h-[52px] items-center gap-3 px-4 backdrop-blur lg:px-6">
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

      <span
        className="flex min-w-0 items-center gap-1.5 text-sm font-medium"
        data-testid="screen-title"
      >
        <span className={cn("truncate", title === undefined ? "text-fg-0" : "text-fg-2")}>
          {crumb}
        </span>
        {title === undefined ? null : (
          <>
            <span aria-hidden="true" className="text-fg-disabled">
              /
            </span>
            <span className="text-fg-0 truncate">{title}</span>
          </>
        )}
      </span>

      <div className="ml-auto flex items-center gap-2.5">
        {/*
          The canvas ships the shell in two widths and lets the reader switch
          between them from here. It is a real preference, remembered per
          browser (`useNavModel`), and there is nothing below `lg` to switch —
          both widths collapse into the same sheet.
        */}
        <span
          role="group"
          aria-label="Navigation width"
          className="border-border hidden items-center gap-0.5 rounded-sm border p-px lg:flex"
          data-testid="nav-model-switch"
        >
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
          className="border-border bg-sunken text-fg-2 hover:border-border-hover hover:text-fg-1 hidden h-8 w-60 items-center gap-2 rounded-sm border px-2.5 text-xs transition-colors md:flex"
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Search projects and actions</span>
          <ShortcutHint keys={keys} />
        </button>
        {/* Below `md` the search field has no room, but search must not vanish. */}
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Search projects and actions"
          onClick={onOpenPalette}
          data-testid="open-palette-compact"
        >
          <Search aria-hidden="true" />
        </Button>

        <Button variant="secondary" size="sm" asChild data-testid="new-project">
          <Link href="/?new=1" aria-label="New project">
            <Plus aria-hidden="true" />
            <span aria-hidden="true" className="hidden sm:inline">
              New project
            </span>
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

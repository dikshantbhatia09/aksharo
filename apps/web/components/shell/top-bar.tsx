"use client";

import { Menu, Plus, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { Button, ShortcutHint, shortcutKeys, Sheet, SheetContent, SheetTitle } from "@montaj/ui";

import { Sidebar, UpgradeButton } from "./sidebar";

/**
 * The top bar of 08 §3: search (Ctrl+K), New project, What's new, Upgrade.
 *
 * On a narrow viewport the sidebar collapses into a sheet that this bar opens,
 * which is why the mobile trigger lives here rather than in the sidebar.
 */
export function TopBar({
  onOpenPalette,
  hasWhatsNew = false,
}: {
  onOpenPalette: () => void;
  hasWhatsNew?: boolean;
}): React.JSX.Element {
  const [navOpen, setNavOpen] = React.useState(false);
  const [keys, setKeys] = React.useState<readonly string[]>(["Ctrl", "K"]);

  // The modifier glyph depends on the platform, which only the browser knows;
  // reading it during render would make the server and client markup disagree.
  React.useEffect(() => {
    setKeys(shortcutKeys(["Ctrl", "K"]));
  }, []);

  return (
    <header className="border-border bg-bg-0/95 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-3 backdrop-blur">
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

      <button
        type="button"
        onClick={onOpenPalette}
        data-testid="open-palette"
        className="border-border bg-bg-1 text-fg-2 hover:border-fg-2/60 flex h-9 max-w-md flex-1 items-center gap-2 rounded-sm border px-3 text-sm"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">Search projects and actions</span>
        <ShortcutHint keys={keys} />
      </button>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" asChild data-testid="new-project">
          <Link href="/?new=1">
            <Plus aria-hidden="true" />
            <span className="hidden sm:inline">New project</span>
          </Link>
        </Button>

        <Button
          variant="outline"
          size="sm"
          asChild
          className="border-border bg-bg-1 text-fg-1 hover:bg-bg-2 hover:text-fg-0 h-8 gap-1.5 px-3 text-xs"
          data-testid="aura-button"
        >
          <Link href="/billing">
            <span className="text-[#F59E0B] font-bold">✦</span>
            <span>Aura</span>
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
                className="bg-lime-500 absolute top-1.5 right-1.5 size-2 rounded-full"
              />
            ) : null}
          </Link>
        </Button>

        <UpgradeButton />
      </div>
    </header>
  );
}

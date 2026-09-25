"use client";

import { Film, FilePlus2, Settings, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  ShortcutHint,
  shortcutKeys,
} from "@montaj/ui";

import { ALL_NAV, SETTINGS_NAV } from "@/lib/nav";

/**
 * Ctrl+K (⌘K on a Mac).
 *
 * The palette is the fastest route to anything, so it lists the same navigation
 * the sidebar does plus the actions that have no home yet. Recent projects come
 * from A14 through `recentProjects`, which is empty until then rather than
 * pretending to have history.
 */

export interface RecentProject {
  id: string;
  title: string;
  href: string;
}

export interface CommandAction {
  id: string;
  label: string;
  run: () => void;
  keys?: readonly string[];
  icon?: React.ReactNode;
}

export function useCommandPalette(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return { open, setOpen };
}

export function CommandPalette({
  open,
  onOpenChange,
  recentProjects = [],
  extraActions = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recentProjects?: readonly RecentProject[];
  extraActions?: readonly CommandAction[];
}): React.JSX.Element {
  const router = useRouter();

  const go = React.useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [onOpenChange, router],
  );

  const actions: CommandAction[] = [
    {
      id: "new-project",
      label: "New project",
      keys: shortcutKeys(["Ctrl", "N"]),
      icon: <FilePlus2 aria-hidden="true" />,
      run: () => {
        go("/?new=1");
      },
    },
    {
      id: "settings",
      label: "Open settings",
      icon: <Settings aria-hidden="true" />,
      run: () => {
        go("/settings/profile");
      },
    },
    {
      id: "privacy",
      label: "Privacy and consents",
      icon: <ShieldCheck aria-hidden="true" />,
      run: () => {
        go("/settings/privacy");
      },
    },
    ...extraActions,
  ];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      description="Search your projects and jump to anything in Aksharo."
    >
      <CommandInput placeholder="Search projects and actions" data-testid="command-input" />
      <CommandList>
        <CommandEmpty>No project or action matches. Try a project name.</CommandEmpty>

        {recentProjects.length > 0 ? (
          <CommandGroup heading="Recent projects">
            {recentProjects.map((project) => (
              <CommandItem
                key={project.id}
                value={`project ${project.title}`}
                onSelect={() => {
                  go(project.href);
                }}
              >
                <Film aria-hidden="true" />
                <span className="truncate">{project.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Actions">
          {actions.map((action) => (
            <CommandItem key={action.id} value={action.label} onSelect={action.run}>
              {action.icon}
              {action.label}
              {action.keys === undefined ? null : <ShortcutHint keys={action.keys} />}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Go to">
          {/*
            Every navigable destination, not just the rail's eight: the palette
            has no width to run out of, so the routes the rail could not fit
            (Academy, Plugins, Team, Refer & Earn, Help) stay one keystroke
            away. `ready` still filters — an unbuilt page must never be a
            one-keystroke path to a 404.
          */}
          {ALL_NAV.filter((item) => item.ready).map((item) => (
            <CommandItem
              key={item.key}
              value={`go ${item.label}`}
              onSelect={() => {
                go(item.href);
              }}
            >
              <item.icon aria-hidden="true" />
              {item.label}
            </CommandItem>
          ))}
          {SETTINGS_NAV.map((section) => (
            <CommandItem
              key={section.key}
              value={`settings ${section.label}`}
              onSelect={() => {
                go(section.href);
              }}
            >
              <Settings aria-hidden="true" />
              {section.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

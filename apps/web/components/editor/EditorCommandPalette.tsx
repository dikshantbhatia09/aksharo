"use client";

/**
 * The editor's command palette (OC-04, ARCHITECTURE §6).
 *
 * The registry's *second* renderer: like `EditorMenubar` it knows no labels,
 * no shortcuts and no enablement rules of its own — it renders
 * `EDITOR_ACTIONS`. The one deliberate difference from the menubar is the
 * `enabled(ctx)` filter: a menu teaches (a disabled "Split segment" tells you
 * the feature exists and what it needs), a palette executes, so an action that
 * cannot run is not offered at all.
 *
 * Ctrl+K is bound in the **capture** phase and stops propagation. The shell's
 * global palette (`components/shell/command-palette.tsx` line 56) listens on
 * `window` in the bubble phase with no capture option, so while `/p/[id]` is
 * mounted this listener runs first and the shell's never sees the key — one
 * Ctrl+K, one palette, no race and no timers.
 */

import * as React from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
  KbdGroup,
} from "@montaj/ui";

import { isTextEntryTarget } from "@/lib/edg/keyboard-shortcuts";
import { EDITOR_ACTIONS, EDITOR_MENUS, type EditorActionContext } from "@/lib/editor/actions";

export interface EditorCommandPaletteProps {
  readonly ctx: EditorActionContext;
}

export function EditorCommandPalette({ ctx }: EditorCommandPaletteProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (isTextEntryTarget(event.target)) return; // typing wins, as everywhere else
        event.preventDefault();
        event.stopPropagation(); // capture phase: the shell's global palette must not also open
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      label="Editor commands"
      description="Search every editor action; Enter runs it."
    >
      <CommandInput placeholder="Type a command…" data-testid="editor-palette-input" />
      <CommandList data-testid="editor-palette-list">
        <CommandEmpty>No matching command.</CommandEmpty>
        {EDITOR_MENUS.map((menu) => {
          const actions = EDITOR_ACTIONS.filter(
            (action) => action.menu === menu.id && action.enabled(ctx),
          );
          if (actions.length === 0) return null;
          return (
            <CommandGroup key={menu.id} heading={menu.label}>
              {actions.map((action) => (
                <CommandItem
                  key={action.id}
                  // The menu name is part of the searchable value, so "edit
                  // undo" finds Undo the way the menubar's grouping implies.
                  value={`${menu.label} ${action.label}`}
                  data-testid={`palette-${action.id}`}
                  // Close first, then run: an action that moves focus (the
                  // export or share dialog) would otherwise re-open a palette
                  // that is already closing. Guide troubleshooting §2.
                  onSelect={() => {
                    setOpen(false);
                    action.run(ctx);
                  }}
                  className={action.destructive === true ? "text-red-400" : undefined}
                >
                  {action.label}
                  {action.shortcut === undefined ? null : (
                    <KbdGroup className="ml-auto">
                      {action.shortcut.split("+").map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

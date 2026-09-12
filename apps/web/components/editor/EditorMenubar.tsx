"use client";

/**
 * The editor's menubar (OC-02, ARCHITECTURE §6).
 *
 * It renders `EDITOR_ACTIONS` and knows nothing else: no labels, no shortcuts,
 * no enablement rules of its own. That is the whole point of the registry —
 * OC-04's command palette renders the same array, so an action added there
 * appears in both surfaces without either component being edited. If you find
 * yourself special-casing an action id in this file, the special case belongs
 * in `lib/editor/actions.ts` instead.
 *
 * The one presentational rule that is genuinely the menubar's own: a menu's
 * destructive rows sit in a tail below a separator, so "Delete word" is never
 * the neighbour of the row above it by accident.
 *
 * Kalakar's reference has no visible File/Edit/View/… bar at all, so every
 * `EDITOR_MENUS` entry (2026-09-12) is a submenu of one overflow trigger
 * instead of its own top-level one — same actions, same
 * `menu-item-${action.id}` testids on every row, just one fewer click away.
 * Nothing here reads `EDITOR_ACTIONS` any differently for it; this is a pure
 * "wrap each menu in `MenubarSub` instead of rendering it standalone" change.
 */

import { MoreHorizontal } from "lucide-react";
import * as React from "react";

import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@montaj/ui";

import {
  EDITOR_ACTIONS,
  EDITOR_MENUS,
  type EditorAction,
  type EditorActionContext,
} from "@/lib/editor/actions";

export interface EditorMenubarProps {
  readonly ctx: EditorActionContext;
}

function Row({
  action,
  ctx,
}: {
  action: EditorAction;
  ctx: EditorActionContext;
}): React.JSX.Element {
  const testId = `menu-item-${action.id}`;

  if (action.checked !== undefined) {
    return (
      <MenubarCheckboxItem
        checked={action.checked(ctx)}
        disabled={!action.enabled(ctx)}
        data-testid={testId}
        // The registry's `run` already reads the current value and asks for the
        // opposite, so the checkbox's own `onCheckedChange` would be a second,
        // competing source of the next state. `onSelect` keeps one.
        onSelect={() => {
          action.run(ctx);
        }}
      >
        {action.label}
      </MenubarCheckboxItem>
    );
  }

  return (
    <MenubarItem
      disabled={!action.enabled(ctx)}
      variant={action.destructive === true ? "destructive" : "default"}
      data-testid={testId}
      // Troubleshooting §2: set state and let radix close the menu itself.
      // `preventDefault()` here keeps the menu open on top of the dialog the
      // item just opened.
      onSelect={() => {
        action.run(ctx);
      }}
    >
      {action.label}
      {action.shortcut === undefined ? null : <MenubarShortcut>{action.shortcut}</MenubarShortcut>}
    </MenubarItem>
  );
}

export function EditorMenubar({ ctx }: EditorMenubarProps): React.JSX.Element {
  return (
    <Menubar data-testid="editor-menubar" aria-label="Editor menu" className="border-border bg-bg-0">
      <MenubarMenu>
        <MenubarTrigger
          data-testid="menu-more"
          aria-label="Editor menu"
          title="Editor menu"
          className="hover:bg-bg-2 data-[state=open]:bg-bg-2 flex size-7 items-center justify-center rounded-sm p-0 transition-colors duration-[160ms]"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </MenubarTrigger>
        <MenubarContent>
          {EDITOR_MENUS.map((menu) => {
            const actions = EDITOR_ACTIONS.filter((action) => action.menu === menu.id);
            if (actions.length === 0) return null;
            const safe = actions.filter((action) => action.destructive !== true);
            const destructive = actions.filter((action) => action.destructive === true);

            return (
              <MenubarSub key={menu.id}>
                <MenubarSubTrigger data-testid={`menu-${menu.id}`}>{menu.label}</MenubarSubTrigger>
                <MenubarSubContent>
                  {safe.map((action) => (
                    <Row key={action.id} action={action} ctx={ctx} />
                  ))}
                  {destructive.length === 0 || safe.length === 0 ? null : <MenubarSeparator />}
                  {destructive.map((action) => (
                    <Row key={action.id} action={action} ctx={ctx} />
                  ))}
                </MenubarSubContent>
              </MenubarSub>
            );
          })}
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}

"use client";

// Pattern ported from OpenCut (github.com/opencut-app/opencut, MIT,
// Copyright 2026 OpenCut) — apps/web/src/components/ui/resizable.tsx in the
// 2026 rewrite scaffold — restyled to @montaj/ui tokens; double-click-to-reset
// adopted from its GPUI desktop twin (components/resizable.rs).
import * as React from "react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@montaj/ui";

/**
 * OpenCut's 50-line wrapper is written against react-resizable-panels v2/v3.
 * The version this wave pins (`^4.0.0`, OC ARCHITECTURE §3 — 4.12.3 resolved)
 * renamed most of that surface, so the port follows the installed package's own
 * types (`node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts`,
 * line numbers below) rather than the source file:
 *
 * - `Group` (was `PanelGroup`) takes `orientation`, not `direction` (d.ts:26,131).
 * - The group exposes no forwarded `ref`: its imperative API arrives through the
 *   `groupRef` prop as a `GroupImperativeHandle` (d.ts:37-53, 86-93), whose
 *   `setLayout` takes a map of panel id → percentage, not an array (d.ts:44-52).
 *   Every panel therefore needs an explicit, stable `id`.
 * - `Separator` (was `PanelResizeHandle`) renders `role="separator"` and sets
 *   `aria-orientation` to the axis it *resizes along* — the inverse of its
 *   group's orientation — which is what the `aria-[orientation=horizontal]:`
 *   variants below key off.
 * - Sizes: a bare number means PIXELS in v4; percentages are strings (d.ts:294-346).
 *   Use {@link percent}.
 * - v2's `autoSaveId` became the `useDefaultLayout` hook (d.ts:448-500), wrapped
 *   here as {@link usePersistedLayout}.
 */
export type WorkspaceLayoutHandle = ResizablePrimitive.GroupImperativeHandle;
export type WorkspacePanelHandle = ResizablePrimitive.PanelImperativeHandle;

/** A group's sizes as the library states them: panel id → percentage (0..100). */
export type WorkspaceLayout = ResizablePrimitive.Layout;

/** v4 reads bare numbers as pixels; a percentage has to say so (d.ts:294-346). */
export function percent(value: number): string {
  return `${value}%`;
}

export function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group>): React.JSX.Element {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn("bg-bg-1 min-h-0 min-w-0", className)}
      {...props}
    />
  );
}

export function ResizablePanel({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel>): React.JSX.Element {
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      className={cn("bg-bg-1 min-h-0 min-w-0", className)}
      {...props}
    />
  );
}

export function ResizableHandle({
  className,
  onResetLayout,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
  /** Double-click restores the group's default layout (OpenCut desktop parity). */
  onResetLayout?: () => void;
}): React.JSX.Element {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      onDoubleClick={onResetLayout}
      className={cn(
        "bg-border relative flex w-px items-center justify-center transition-colors duration-[160ms]",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-1.5 after:-translate-x-1/2",
        "hover:bg-lime-500/40 focus-visible:ring-1 focus-visible:ring-lime-500 focus-visible:outline-none",
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
        "aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1.5",
        "aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `useDefaultLayout` reads its storage while rendering (it feeds
 * `useSyncExternalStore`, whose *server* snapshot is the same read — d.ts:448),
 * and it defaults to bare `localStorage`, which does not exist on the server and
 * throws in a browser with site data blocked. This is the app's standard guarded
 * accessor (`lib/privacy/consent.ts`), kept at module scope because the hook
 * memoises on the storage identity.
 */
const layoutStorage: ResizablePrimitive.LayoutStorage = {
  getItem: (key) => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      // Private mode, or storage disabled: no remembered layout, defaults apply.
      return null;
    }
  },
  setItem: (key, value) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Nothing to do — the layout simply is not remembered on this device.
    }
  },
};

/**
 * Per-device layout persistence, v4's replacement for `autoSaveId`. Spread the
 * result onto a {@link ResizablePanelGroup}; it stores the group's percentages
 * under `react-resizable-panels:<id>`.
 *
 * The `id` must be a literal that never changes between renders, or the group
 * saves under one key and restores from another.
 */
export function usePersistedLayout(id: string): {
  defaultLayout: WorkspaceLayout | undefined;
  onLayoutChanged: (layout: WorkspaceLayout, meta: ResizablePrimitive.LayoutChangedMeta) => void;
} {
  const { defaultLayout, onLayoutChanged } = ResizablePrimitive.useDefaultLayout({
    id,
    storage: layoutStorage,
  });
  return { defaultLayout, onLayoutChanged };
}

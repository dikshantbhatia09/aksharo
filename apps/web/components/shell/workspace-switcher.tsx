"use client";

import { ChevronsUpDown } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useSession, useSwitchWorkspace, useWorkspaces } from "@montaj/api-client";
import type { TokenResponse } from "@montaj/api-client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  toast,
} from "@montaj/ui";

import { messageForError } from "@/lib/errors";
import { persistSession } from "@/lib/session/client";

/**
 * Switching workspace is a **token exchange**, never a header (CONTRACTS §5,
 * THREAT-MODEL T4): the API mints a new session bound to the new workspace and
 * re-checks the membership while doing it. The hook clears the whole query cache
 * on success, so nothing from the previous workspace can survive the switch.
 */
export function WorkspaceSwitcher({
  compact = false,
}: {
  /**
   * The canvas's sidebar does not give the workspace a control of its own: it
   * is a 10 px uppercase line under the brand name ("ISHAAN'S WORKSPACE"). In
   * `compact` this renders as that line — still a real menu when there is more
   * than one workspace to switch to, still the same token exchange, just
   * without the bordered box.
   */
  compact?: boolean;
} = {}): React.JSX.Element {
  const session = useSession();
  const workspaces = useWorkspaces();
  const router = useRouter();

  const onTokens = React.useCallback(async (tokens: TokenResponse) => {
    await persistSession(tokens);
  }, []);

  const switchWorkspace = useSwitchWorkspace(onTokens);

  const current = workspaces.data?.find((workspace) => workspace.id === session?.workspaceId);
  const label = current?.name ?? (session === null ? "Signed out" : "Your workspace");

  const handleSelect = (workspaceId: string): void => {
    if (workspaceId === session?.workspaceId) return;
    switchWorkspace.mutate(workspaceId, {
      onSuccess: () => {
        router.refresh();
      },
      onError: (error) => {
        toast.error("Could not switch workspace", { description: messageForError(error) });
      },
    });
  };

  if (workspaces.isPending && session !== null) {
    return <Skeleton className={compact ? "h-4 w-28" : "h-9 w-full"} />;
  }

  // With one workspace there is nothing to switch to, so the control is a label
  // rather than a menu that opens onto a single item.
  const options = workspaces.data ?? [];
  if (options.length < 2) {
    // A plain line, not a bordered box: a box reads as a control, and with one
    // workspace there is nothing to operate.
    return compact ? (
      <span className="text-fg-2 truncate text-xs" data-testid="workspace-switcher">
        {label}
      </span>
    ) : (
      <div
        className="text-fg-2 flex min-h-8 min-w-0 items-center px-2.5 text-xs"
        data-testid="workspace-switcher"
      >
        <span className="truncate">{label}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            type="button"
            className="text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0 -mx-1 flex min-h-8 max-w-full items-center gap-1 truncate rounded-sm px-1 text-xs"
            data-testid="workspace-switcher"
            disabled={switchWorkspace.isPending}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden="true" />
          </button>
        ) : (
          <Button
            variant="outline"
            className="w-full justify-between px-2.5"
            data-testid="workspace-switcher"
            disabled={switchWorkspace.isPending}
          >
            <span className="truncate">{label}</span>
            <ChevronsUpDown className="text-fg-2 size-4 shrink-0" aria-hidden="true" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={session?.workspaceId ?? ""} onValueChange={handleSelect}>
          {options.map((workspace) => (
            <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
              <span className="truncate">{workspace.name}</span>
              <span className="text-fg-2 ml-auto text-2xs capitalize">{workspace.role}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

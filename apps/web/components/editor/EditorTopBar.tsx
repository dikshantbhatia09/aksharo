"use client";

/**
 * The studio editor's own top bar (design/05-SCREEN-EDITOR-SHELL.md §1),
 * replacing the dashboard shell's sidebar + search/New-project/Aura top bar
 * on this one route (`AppShell`'s `isEditorRoute` branch) — a 4-zone studio
 * editor has no room for either, and Kalakar's own top bar is just this:
 * back arrow, a synced-to-cloud dot, an inline-editable title, Upgrade, and
 * the account menu.
 *
 * `UpgradeButton` and `ProfileMenu` are the dashboard shell's own components,
 * reused as-is rather than forked — both are already self-contained (they
 * fetch their own data) and layout-agnostic enough to sit in a slim bar
 * instead of a sidebar footer.
 */
import { Home } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { useUpdateProject } from "@montaj/api-client";

import { ProfileMenu } from "@/components/shell/profile-menu";
import { UpgradeButton } from "@/components/shell/sidebar";
import { cn } from "@/lib/utils";

export interface EditorTopBarProps {
  readonly projectId: string;
  readonly title: string;
  readonly className?: string;
}

export function EditorTopBar({
  projectId,
  title,
  className,
}: EditorTopBarProps): React.JSX.Element {
  const updateProject = useUpdateProject();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  function startEditing(): void {
    setDraft(title);
    setEditing(true);
  }

  function commit(): void {
    setEditing(false);
    const next = draft.trim();
    if (next === "" || next === title) return;
    updateProject.mutate({ projectId, body: { title: next } });
  }

  return (
    <header
      className={cn(
        "editor-top-bar bg-bg-0 flex h-[42px] shrink-0 items-center gap-2.5 px-3",
        className,
      )}
      data-testid="editor-top-bar"
    >
      <Link
        href="/"
        aria-label="Back to projects"
        title="Back to projects"
        className="bg-mint text-on-accent hover:bg-mint-hover flex size-7 shrink-0 items-center justify-center rounded-sm transition-colors duration-[160ms]"
        data-testid="editor-back-link"
      >
        <Home className="size-4" aria-hidden="true" />
      </Link>

      {editing ? (
        <input
          autoFocus
          value={draft}
          data-testid="editor-title-input"
          aria-label="Project title"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
          className="text-fg-0 border-lime-500/60 bg-bg-0 min-w-0 flex-1 rounded-sm border px-1.5 py-0.5 text-sm font-medium outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={startEditing}
          title="Rename project"
          data-testid="editor-title-button"
          className="text-fg-0 hover:bg-bg-2 min-w-0 flex-1 truncate rounded-sm py-0.5 text-left text-[15px] font-medium tracking-[-0.01em] transition-colors duration-[160ms]"
        >
          {title}
        </button>
      )}

      <UpgradeButton editor />
      <ProfileMenu editor />
    </header>
  );
}

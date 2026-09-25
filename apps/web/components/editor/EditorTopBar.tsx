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
 *
 * Shirorekha (docs/redesign/DESIGN.md): the project title is this page's
 * title, so it is the page's one `h1`, set in the display face and hung from
 * the shirorekha bar, the same signature `PageHeader` draws on every other
 * page. `PageHeader` itself is not used here: its 28 px title and wrapping
 * description would cost the footage vertical space in a 48 px tool bar. The
 * back link is a neutral ghost icon button; it used to be an accent-filled
 * tile, which spent the accent on navigation rather than on Export.
 */
import { ArrowLeft } from "lucide-react";
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
      className={cn("editor-top-bar bg-bg-0 flex h-12 shrink-0 items-center gap-3 px-3", className)}
      data-testid="editor-top-bar"
    >
      <Link
        href="/"
        aria-label="Back to projects"
        title="Back to projects"
        className="text-fg-2 hover:bg-neutral-100/7 hover:text-fg-0 active:bg-neutral-100/14 flex size-8 shrink-0 items-center justify-center rounded-sm transition-colors duration-[160ms]"
        data-testid="editor-back-link"
      >
        <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </Link>

      <h1 className="shirorekha m-0 flex min-w-0 flex-1 items-center">
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
            className="text-fg-0 border-border-hover bg-sunken font-display min-w-0 flex-1 rounded-sm border px-1.5 py-0.5 text-lg font-semibold [font-stretch:92%]"
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            title="Rename project"
            data-testid="editor-title-button"
            className="text-fg-0 hover:bg-neutral-100/7 font-display min-w-0 max-w-full truncate rounded-sm px-1 py-0.5 text-left text-lg font-semibold tracking-[-0.01em] [font-stretch:92%] transition-colors duration-[160ms]"
          >
            {title}
          </button>
        )}
      </h1>

      <UpgradeButton editor />
      <ProfileMenu editor />
    </header>
  );
}

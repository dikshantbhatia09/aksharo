"use client";

/**
 * `/projects`' folder list: create, rename, and pick one to filter by
 * (`folderId` on `GET /projects`, 07 §Projects). Nesting exists server-side
 * (`parentId`, eight deep) but this renders one flat, alphabetised list —
 * a tree widget is more chrome than an agency with a handful of client
 * folders needs, and every folder still carries its own `parentId` for when
 * a deeper view is worth building.
 */
import { Folder, FolderPlus, Folders, Pencil } from "lucide-react";
import * as React from "react";

import { useCreateFolder, useFolders, useUpdateFolder } from "@montaj/api-client";
import { Button, cn, Input, toast } from "@montaj/ui";

import { messageForError } from "@/lib/errors";

/**
 * The canvas's folder row: a 14 px icon, the name, and — pushed right — the
 * count. Selected is an accent tint rather than a raised grey, which is how
 * Nocturne marks "this one" everywhere else in the shell.
 */
const ROW =
  "flex items-center gap-2 rounded-sm px-2.5 py-[7px] text-left text-[12.5px] transition-colors duration-[160ms] ease-[var(--ease-out-soft)]";
const ROW_ON = "bg-accent/12 text-accent-200";
const ROW_OFF = "text-neutral-300 hover:bg-neutral-100/6 hover:text-fg-0";

export function FolderSidebar({
  selectedFolderId,
  onSelect,
}: {
  /** `undefined` = all projects; `"root"` = only ungrouped ones. */
  selectedFolderId: string | undefined;
  onSelect: (folderId: string | undefined) => void;
}): React.JSX.Element {
  const folders = useFolders();
  const createFolder = useCreateFolder();
  const updateFolder = useUpdateFolder();
  const [creating, setCreating] = React.useState(false);
  const [draftName, setDraftName] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = React.useState("");

  const items = [...(folders.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <nav aria-label="Folders" className="flex flex-col gap-0.5" data-testid="folder-sidebar">
      <span className="text-neutral-500 px-2.5 pb-1.5 text-[9.5px] tracking-[0.12em] uppercase">
        Folders
      </span>
      <button
        type="button"
        onClick={() => {
          onSelect(undefined);
        }}
        className={cn(ROW, selectedFolderId === undefined ? ROW_ON : ROW_OFF)}
        data-testid="folder-all"
      >
        <Folders className="size-3.5 shrink-0" aria-hidden="true" />
        All projects
      </button>
      <button
        type="button"
        onClick={() => {
          onSelect("root");
        }}
        className={cn(ROW, selectedFolderId === "root" ? ROW_ON : ROW_OFF)}
        data-testid="folder-root"
      >
        <Folder className="size-3.5 shrink-0" aria-hidden="true" />
        No folder
      </button>

      {items.map((folder) =>
        renamingId === folder.id ? (
          <form
            key={folder.id}
            className="flex items-center gap-1 px-1"
            onSubmit={(event) => {
              event.preventDefault();
              const name = renameDraft.trim();
              if (name === "") return;
              updateFolder.mutate(
                { folderId: folder.id, body: { name } },
                {
                  onError: (error) => {
                    toast.error("Could not rename that folder", {
                      description: messageForError(error),
                    });
                  },
                },
              );
              setRenamingId(undefined);
            }}
          >
            <Input
              autoFocus
              value={renameDraft}
              onChange={(event) => {
                setRenameDraft(event.target.value);
              }}
              onBlur={() => {
                setRenamingId(undefined);
              }}
              className="h-8 text-sm"
              aria-label={`Rename ${folder.name}`}
              data-testid="folder-rename-input"
            />
          </form>
        ) : (
          <div key={folder.id} className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onSelect(folder.id);
              }}
              className={cn(
                ROW,
                "flex-1 truncate",
                selectedFolderId === folder.id ? ROW_ON : ROW_OFF,
              )}
              data-testid={`folder-${folder.id}`}
            >
              <Folder className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{folder.name}</span>
              {/* A real separator, not just a margin: without it the accessible
                  name reads "Client work0" (F07-E2). */}
              <span className="text-neutral-500 ml-auto text-[10px]">{` · ${String(folder.projectCount)}`}</span>
            </button>
            <button
              type="button"
              aria-label={`Rename ${folder.name}`}
              className="text-fg-2 hover:text-fg-0 rounded-sm p-1 opacity-0 group-hover:opacity-100"
              onClick={() => {
                setRenamingId(folder.id);
                setRenameDraft(folder.name);
              }}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ),
      )}

      {creating ? (
        <form
          className="px-1"
          onSubmit={(event) => {
            event.preventDefault();
            const name = draftName.trim();
            if (name === "") {
              setCreating(false);
              return;
            }
            createFolder.mutate(
              { name },
              {
                onError: (error) => {
                  toast.error("Could not create that folder", {
                    description: messageForError(error),
                  });
                },
              },
            );
            setDraftName("");
            setCreating(false);
          }}
        >
          <Input
            autoFocus
            placeholder="Name, then press Enter"
            value={draftName}
            onChange={(event) => {
              setDraftName(event.target.value);
            }}
            onBlur={() => {
              setCreating(false);
            }}
            className="h-8 text-sm"
            data-testid="folder-create-input"
          />
        </form>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setCreating(true);
          }}
          className="justify-start"
          data-testid="folder-create"
        >
          <FolderPlus aria-hidden="true" />
          New folder
        </Button>
      )}
    </nav>
  );
}

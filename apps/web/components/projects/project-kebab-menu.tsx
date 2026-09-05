"use client";

/**
 * The kebab menu every project card and row carries (08 §Home): open,
 * duplicate, export, import subtitles, share, archive, delete with confirm.
 *
 * Export shipped (A19/A21b): this item navigates to the project's editor with
 * `?export=1`, which opens the same export dialog the editor's own toolbar
 * button opens (F07-E5).
 *
 * Share is still disabled. B15 built the share-link API and
 * `components/review/ShareLinksPanel.tsx`, but nothing in the app mounts that
 * panel, so there is no owner-side share screen to send anyone to. A disabled
 * item with an honest tooltip beats a menu entry that navigates nowhere,
 * matching how `nav.ts` handles an unbuilt route.
 */
import {
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  ExternalLink,
  Info,
  MoreHorizontal,
  Share2,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useCreateProject, useDeleteProject, useUpdateProject } from "@montaj/api-client";
import type { Project } from "@montaj/api-client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@montaj/ui";

import { ImportSubtitles } from "@/components/editor/ImportSubtitles";
import { messageForError } from "@/lib/errors";

export function ProjectKebabMenu({
  project,
  onViewDetails,
}: {
  project: Project;
  /** `/projects` opens the detail sheet from here; Home has no sheet to open. */
  onViewDetails?: (projectId: string) => void;
}): React.JSX.Element {
  const router = useRouter();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const archived = project.status === "archived";

  const duplicate = (): void => {
    createProject.mutate(
      {
        title: `${project.title} copy`,
        ...(project.folderId === null ? {} : { folderId: project.folderId }),
        ...(project.clientTag === null ? {} : { clientTag: project.clientTag }),
        aspect: project.aspect,
        ...(project.sourceLanguage === null ? {} : { sourceLanguage: project.sourceLanguage }),
      },
      {
        onError: (error) => {
          toast.error("Could not duplicate that project", { description: messageForError(error) });
        },
      },
    );
  };

  const toggleArchive = (): void => {
    updateProject.mutate(
      { projectId: project.id, body: { status: archived ? "active" : "archived" } },
      {
        onError: (error) => {
          toast.error("Could not update that project", { description: messageForError(error) });
        },
      },
    );
  };

  const confirmDelete = (): void => {
    deleteProject.mutate(project.id, {
      onSuccess: () => {
        toast.success(`"${project.title}" was deleted.`);
      },
      onError: (error) => {
        toast.error("Could not delete that project", { description: messageForError(error) });
      },
    });
    setConfirmingDelete(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="text-fg-2 hover:text-fg-0 hover:bg-bg-2 rounded-sm p-1.5"
            aria-label={`More actions for ${project.title}`}
            data-testid={`project-kebab-${project.id}`}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
          <DropdownMenuItem
            onSelect={() => {
              router.push(`/p/${project.id}`);
            }}
            data-testid="kebab-open"
          >
            <ExternalLink aria-hidden="true" />
            Open
          </DropdownMenuItem>
          {onViewDetails === undefined ? null : (
            <DropdownMenuItem
              onSelect={() => {
                onViewDetails(project.id);
              }}
              data-testid="kebab-details"
            >
              <Info aria-hidden="true" />
              Details
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={duplicate} data-testid="kebab-duplicate">
            <Copy aria-hidden="true" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              router.push(`/p/${project.id}?export=1`);
            }}
            data-testid="kebab-export"
          >
            <Download aria-hidden="true" />
            Export
          </DropdownMenuItem>
          {/*
            S-03: bring your own captions, from the grid as well as from the
            editor's waiting screen. Offered for every project, with no
            client-side gating: whether a project that already has a transcript
            gets a refusal or a re-align is the route's answer to give, and the
            control's toast repeats it. Inventing a rule here that the server
            does not have is exactly how the two drift apart.
          */}
          <ImportSubtitles projectId={project.id} variant="menu-item" />
          {/*
            Share stays disabled, and the tooltip now says why: B15 built the
            share-link API and `components/review/ShareLinksPanel.tsx`, but that
            panel was never given an entry point anywhere in the app (its own
            header says so), so there is no share surface to navigate to. See
            REPORT.md, F07-E5 — the second half of that item is reported, not
            improvised into a new screen.
          */}
          <DisabledMenuItem label="Share" reason="Share links have no owner-side screen yet." />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={toggleArchive} data-testid="kebab-archive">
            {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setConfirmingDelete(true);
            }}
            data-testid="kebab-delete"
            className="text-rejected"
          >
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent data-testid="delete-confirm-dialog">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{project.title}&rdquo;?</DialogTitle>
          </DialogHeader>
          <p className="text-fg-1 text-sm">
            This project moves to Archive-then-delete: nothing in storage is removed yet, but it
            leaves your Recent grid and your workspace&apos;s retention window applies from here.
          </p>
          <DialogFooter>
            <button
              type="button"
              className="text-fg-1 hover:text-fg-0 rounded-sm px-3 py-2 text-sm"
              onClick={() => {
                setConfirmingDelete(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="bg-rejected rounded-sm px-3 py-2 text-sm font-medium text-white"
              onClick={confirmDelete}
              data-testid="confirm-delete"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DisabledMenuItem({ label, reason }: { label: string; reason: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem disabled data-testid={`kebab-${label.toLowerCase()}`}>
          <Share2 aria-hidden="true" />
          {label}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="left">{reason}</TooltipContent>
    </Tooltip>
  );
}

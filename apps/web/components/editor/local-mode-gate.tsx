"use client";

/**
 * Local-mode gating (brief C04b §3): a local project is offline by design
 * (C04 "no uploads of any kind"), so every surface that needs the cloud —
 * a pass (worker AI, credits), a cloud render fallback, share, an upsell —
 * has to say so plainly rather than fail with a raw network error the
 * moment it tries. `LocalModeNotice` is the one affordance every such
 * surface renders: greyed control, "cloud project — upload to use" copy,
 * and a one-click "Upload to cloud" that hands the local document over via
 * `POST /projects/{id}/edg/import` (C04b §1 extended that route to carry
 * transcript chunks too, so a project uploaded this way keeps every
 * word-addressed edit intact).
 *
 * `apps/web/lib/edg/store.ts`'s local branch (this WP) is the sibling piece:
 * it is what makes a local project's `EditorStore` capable of producing the
 * `hot`/`segments`/`chunks` this upload sends. Nothing here talks to SQLite
 * or IPC directly — `uploadLocalProjectToCloud` takes the desktop's
 * `window.aksharoDesktop.local` API and an API client, exactly like
 * `apps/web/lib/edg/store.ts`'s own local deps do.
 */
import { CloudUpload } from "lucide-react";
import * as React from "react";

import { defineEndpoint, type ApiClient } from "@montaj/api-client";
import type { EdgHot, Segment, TranscriptChunk } from "@montaj/edg";
import { Button } from "@montaj/ui";

import type { AksharoDesktopLocalApi } from "../../lib/desktop";

/** `POST /projects/{id}/edg/import` — not in `apps/web/lib/edg/client.ts` (outside this WP's boundary), so defined here. */
const importEdgDocument = defineEndpoint<
  { hot: EdgHot; segments: Segment[]; chunks?: TranscriptChunk[] },
  { edgId: string; revision: number; segments: number }
>({
  method: "POST",
  path: "/projects/{projectId}/edg/import",
  auth: "bearer",
  operationId: "importEdgDocument",
});

export class LocalProjectNotSavedError extends Error {
  constructor() {
    super("This local project has no saved document yet — save an edit before uploading.");
    this.name = "LocalProjectNotSavedError";
  }
}

/**
 * Hands a local project's current document (and transcript chunks, when it
 * has any) to a brand-new cloud project. Mirrors
 * `apps/web/lib/edg/store.ts#createLocalEditorStoreDeps`'s own read of
 * `local.latestSnapshot` — this is the "Upload to cloud" the brief asks the
 * gate to trigger, not a new local-store code path.
 */
export async function uploadLocalProjectToCloud(input: {
  local: AksharoDesktopLocalApi;
  client: ApiClient;
  cloudProjectId: string;
  localProjectId: string;
}): Promise<{ edgId: string; revision: number; segments: number }> {
  const snapshot = await input.local.latestSnapshot(input.localProjectId);
  if (snapshot === null) throw new LocalProjectNotSavedError();

  return input.client.call(importEdgDocument, {
    params: { projectId: input.cloudProjectId },
    body: {
      hot: snapshot.hot as EdgHot,
      segments: snapshot.segments as Segment[],
      ...(snapshot.chunks.length > 0 ? { chunks: snapshot.chunks as TranscriptChunk[] } : {}),
    },
  });
}

export interface LocalModeNoticeProps {
  /** What is being gated, for the copy ("passes", "cloud rendering", "sharing"). */
  readonly feature: string;
  readonly onUploadToCloud?: () => void;
  readonly uploading?: boolean;
  readonly className?: string;
}

/**
 * The "cloud project — upload to use" affordance every gated surface shows.
 * A plain notice, not a modal: the caller decides whether it replaces the
 * gated control or sits alongside it (disabled).
 */
export function LocalModeNotice(props: LocalModeNoticeProps): React.JSX.Element {
  return (
    <div
      className="border-border bg-bg-2 flex items-center gap-3 rounded-md border p-3 text-sm"
      data-testid="local-mode-notice"
    >
      <CloudUpload className="text-fg-3 size-4 shrink-0" />
      <p className="text-fg-2 flex-1">
        This is a local project — upload to cloud to use {props.feature}.
      </p>
      {props.onUploadToCloud === undefined ? null : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={props.onUploadToCloud}
          disabled={props.uploading === true}
          data-testid="local-mode-upload"
        >
          {props.uploading === true ? "Uploading…" : "Upload to cloud"}
        </Button>
      )}
    </div>
  );
}

"use client";

import * as React from "react";

import { useApiContext } from "@montaj/api-client";

import { deleteUploadRecord, listResumableUploads } from "./store";
import { UploadJob } from "./upload-job";

import type { UploadItemState, UploadQuickPick } from "./types";

/**
 * One upload queue per Home page, holding every file currently hashing,
 * uploading, or just finished — batch upload (dropping several files at
 * once) is simply adding several jobs, each running independently and
 * reported separately.
 *
 * On mount it also offers back whatever `listResumableUploads()` finds in
 * IndexedDB: a file dropped just before a reload does not have to be picked
 * again.
 */
export function useUploadQueue(): {
  items: readonly UploadItemState[];
  addFiles: (files: readonly File[], quickPick: UploadQuickPick) => void;
  /** Batch (B15): each file uploads straight into an already-created project. */
  addFilesToProjects: (
    pairs: readonly { readonly file: File; readonly projectId: string }[],
    quickPick: UploadQuickPick,
  ) => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
} {
  const { client } = useApiContext();
  const [items, setItems] = React.useState<Record<string, UploadItemState>>({});
  const jobs = React.useRef<Map<string, UploadJob>>(new Map());

  const update = React.useCallback((state: UploadItemState) => {
    setItems((current) => ({ ...current, [state.id]: state }));
  }, []);

  const addFiles = React.useCallback(
    (files: readonly File[], quickPick: UploadQuickPick) => {
      for (const file of files) {
        const localId =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const job = new UploadJob({ client, file, quickPick, localId, onUpdate: update });
        jobs.current.set(localId, job);
        update({
          id: localId,
          fileName: file.name,
          fileSize: file.size,
          status: "hashing",
          progress: { uploadedBytes: 0, totalBytes: file.size, completedParts: 0, totalParts: 0 },
        });
        void job.run();
      }
    },
    [client, update],
  );

  const addFilesToProjects = React.useCallback(
    (
      pairs: readonly { readonly file: File; readonly projectId: string }[],
      quickPick: UploadQuickPick,
    ) => {
      for (const { file, projectId } of pairs) {
        const localId =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const job = new UploadJob({
          client,
          file,
          quickPick,
          localId,
          onUpdate: update,
          existingProjectId: projectId,
        });
        jobs.current.set(localId, job);
        update({
          id: localId,
          fileName: file.name,
          fileSize: file.size,
          status: "hashing",
          progress: { uploadedBytes: 0, totalBytes: file.size, completedParts: 0, totalParts: 0 },
        });
        void job.run();
      }
    },
    [client, update],
  );

  // Offer resumable uploads back once, on mount — a reload mid-upload should
  // not silently drop the file, and it should not be picked up twice either.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resumable = await listResumableUploads();
      if (cancelled) return;
      for (const record of resumable) {
        if (jobs.current.has(record.id)) continue;
        const file = new File([record.fileBytes], record.fileName, { type: record.fileType });
        const job = new UploadJob({
          client,
          file,
          // FIX-04: a resumed upload has no picker behind it and the project
          // it belongs to already carries its own `sourceLanguage`, so there is
          // nothing here to choose — and the removed `"hi-Latn"` was the same
          // silent guess the audit found on Home.
          quickPick: { aspect: "9:16" },
          localId: record.id,
          onUpdate: update,
        });
        jobs.current.set(record.id, job);
        update({
          id: record.id,
          fileName: record.fileName,
          fileSize: record.fileSize,
          status: "uploading",
          progress: {
            uploadedBytes: 0,
            totalBytes: record.fileSize,
            completedParts: record.completedParts.length,
            totalParts: record.parts?.length ?? 0,
          },
        });
        void job.resumeFromRecord(record);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once: a queue's own later uploads land through `addFiles`, not by
    // re-scanning IndexedDB.
  }, [client, update]);

  const pause = React.useCallback((id: string) => {
    jobs.current.get(id)?.pause();
  }, []);
  const resume = React.useCallback((id: string) => {
    jobs.current.get(id)?.resume();
  }, []);
  const cancel = React.useCallback((id: string) => {
    void jobs.current.get(id)?.cancel();
  }, []);
  const dismiss = React.useCallback((id: string) => {
    jobs.current.delete(id);
    setItems((current) => {
      const { [id]: _removed, ...rest } = current;
      return rest;
    });
    // Without this, dismissing only ever cleared this row from React state:
    // the IndexedDB record survived, and a row whose job never itself reached
    // a terminal-and-persisted state (a cancel, a duplicate, a clean finish --
    // see `upload-job.ts`) came right back on the next mount via
    // `listResumableUploads()`, exactly as if Dismiss had never been clicked.
    void deleteUploadRecord(id).catch(() => undefined);
  }, []);

  return {
    items: Object.values(items),
    addFiles,
    addFilesToProjects,
    pause,
    resume,
    cancel,
    dismiss,
  };
}

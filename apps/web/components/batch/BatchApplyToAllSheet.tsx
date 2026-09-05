"use client";

/**
 * The "Apply to all" confirm step a multi-file Home drop opens into (B15
 * brief §4): quotes credits up front from each file's own duration (read
 * client-side, before any upload starts), then on confirm creates the batch
 * (`POST /batch`, which tags `POST /projects/batch`'s rows with one
 * `batch_id`) and hands the caller `{file, projectId}` pairs to feed into the
 * existing upload queue (`useUploadQueue().addFilesToProjects`).
 */

import * as React from "react";

import { isApiError } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import type { UploadQuickPick } from "@/lib/upload/types";

import { readFileDurationMs } from "@/lib/batch/duration";
import { useCreateBatch } from "@/lib/share/hooks";

export interface BatchConfirmed {
  readonly batchId: string;
  readonly pairs: readonly { readonly file: File; readonly projectId: string }[];
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^./\\]+$/, "");
  const spaced = withoutExtension.replace(/[_-]+/g, " ").trim();
  return spaced.length > 0 ? spaced : "Untitled project";
}

export function BatchApplyToAllSheet({
  files,
  quickPick,
  onCancel,
  onConfirmed,
}: {
  files: readonly File[];
  quickPick: UploadQuickPick;
  onCancel: () => void;
  onConfirmed: (result: BatchConfirmed) => void;
}): React.JSX.Element {
  const [durationsMs, setDurationsMs] = React.useState<readonly number[] | undefined>(undefined);
  const createBatch = useCreateBatch();

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all(files.map((file) => readFileDurationMs(file))).then((durations) => {
      if (!cancelled) setDurationsMs(durations);
    });
    return () => {
      cancelled = true;
    };
  }, [files]);

  // 1 credit / media minute (transcription rate) — an estimate for display
  // only; `POST /batch/quote` (via `POST /batch`'s own `durationsMs`) holds
  // the number that actually counts, computed server-side from the same rate.
  const estimatedCredits =
    durationsMs === undefined
      ? undefined
      : durationsMs.reduce((sum, ms) => sum + Math.ceil(ms / 60_000), 0);

  const confirm = (): void => {
    createBatch.mutate(
      {
        projects: files.map((file) => ({
          title: titleFromFilename(file.name),
          aspect: quickPick.aspect,
          // FIX-04: `language` is optional now, and an absent one is left
          // absent rather than sent as `undefined` — Home gates the drop on a
          // real pick, so reaching here without one means the server should
          // own the `awaiting_language` story, not guess a lane.
          ...(quickPick.language === undefined ? {} : { sourceLanguage: quickPick.language }),
        })),
        settings: {
          languages:
            quickPick.languages ?? (quickPick.language === undefined ? [] : [quickPick.language]),
          ...(quickPick.styleId === undefined ? {} : { stylePresetId: quickPick.styleId }),
        },
        durationsMs,
      },
      {
        onSuccess: (batch) => {
          const pairs = files.map((file, index) => ({
            file,
            // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
            projectId: batch.projects[index]?.projectId ?? "",
          }));
          onConfirmed({ batchId: batch.id, pairs });
        },
      },
    );
  };

  return (
    <div
      className="border-border bg-bg-1 flex flex-col gap-4 rounded-md border p-4"
      data-testid="batch-apply-sheet"
    >
      <h2 className="text-fg-0 text-lg font-semibold">
        Apply to all {files.length} file{files.length === 1 ? "" : "s"}
      </h2>
      <ul className="text-fg-2 flex flex-col gap-1 text-sm">
        {files.map((file) => (
          <li key={file.name} className="truncate">
            {file.name}
          </li>
        ))}
      </ul>
      <p className="text-fg-2 text-sm" data-testid="batch-quote">
        {estimatedCredits === undefined
          ? "Estimating credits…"
          : `~${String(estimatedCredits)} credits for transcription`}
      </p>
      <div className="flex gap-2">
        <Button
          onClick={confirm}
          disabled={createBatch.isPending || durationsMs === undefined}
          data-testid="batch-confirm"
        >
          {createBatch.isPending ? "Creating…" : `Create ${files.length} projects`}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {createBatch.isError ? (
        <p className="text-sm text-red-400" data-testid="batch-error">
          {isApiError(createBatch.error)
            ? createBatch.error.message
            : "Could not create the batch."}
        </p>
      ) : null}
    </div>
  );
}

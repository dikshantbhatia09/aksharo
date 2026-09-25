"use client";

/**
 * K04: the rail's "Custom Fonts" tab.
 *
 * A genuinely working feature, not a placeholder — `apps/api/src/fonts`
 * already ships the whole pipeline (plan-limit check → presigned single-shot
 * PUT → licence attestation → validate/sanitise/subset to WOFF2 →
 * workspace-scoped list/delete); this panel is the first UI to call it.
 *
 * Flow: pick a file → `useInitFontUpload` (a row + a presigned PUT URL) → PUT
 * the raw bytes straight to storage → show the attestation text and require
 * the checkbox → `useCompleteFontUpload` (validates, subsets, publishes).
 *
 * K01 integration note (also in the work package's REPORT.md): this tab
 * stores and lists uploaded fonts regardless of whether K01's Font Family
 * picker has landed yet. Once it has, that picker's font list should include
 * `useWorkspaceFonts()`'s `ready` rows (id → `family`) alongside the bundled
 * catalogue — this panel does not touch `panels/**`, so that wiring is a
 * follow-up for whoever merges K01 second.
 */
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Trash2,
  Type as TypeIcon,
  Upload,
} from "lucide-react";
import * as React from "react";

import { isApiError } from "@montaj/api-client";
import { Badge, Button, cn } from "@montaj/ui";

import {
  ACCEPTED_FONT_EXTENSIONS,
  MAX_FONT_UPLOAD_BYTES,
  type WorkspaceFontView,
} from "./fonts-endpoints";
import {
  useCompleteFontUpload,
  useDeleteFont,
  useInitFontUpload,
  useWorkspaceFonts,
} from "./use-custom-fonts";

/** A filename without its extension — the same first-guess the server itself falls back to. */
function stemOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return stem.trim().length === 0 ? filename : stem.trim();
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

type Stage =
  | { readonly kind: "idle" }
  | { readonly kind: "uploading"; readonly filename: string }
  | {
      readonly kind: "attest";
      readonly fontId: string;
      readonly filename: string;
      readonly attestation: { readonly version: string; readonly text: string };
    }
  | { readonly kind: "finishing"; readonly fontId: string }
  | { readonly kind: "error"; readonly message: string };

function errorMessage(error: unknown, fallback: string): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function CustomFontsPanel({
  className,
}: {
  readonly className?: string;
}): React.JSX.Element {
  const fonts = useWorkspaceFonts();
  const initUpload = useInitFontUpload();
  const completeUpload = useCompleteFontUpload();
  const deleteFont = useDeleteFont();

  const [stage, setStage] = React.useState<Stage>({ kind: "idle" });
  const [attested, setAttested] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const busy = stage.kind === "uploading" || stage.kind === "finishing";

  async function onFileChosen(file: File): Promise<void> {
    setAttested(false);
    if (file.size > MAX_FONT_UPLOAD_BYTES) {
      setStage({
        kind: "error",
        message: `A font may be at most ${String(Math.round(MAX_FONT_UPLOAD_BYTES / (1024 * 1024)))} MB.`,
      });
      return;
    }
    setStage({ kind: "uploading", filename: file.name });
    try {
      const ticket = await initUpload.mutateAsync({
        filename: file.name,
        sizeBytes: file.size,
        family: stemOf(file.name),
      });
      const put = await fetch(ticket.url, { method: "PUT", body: file });
      if (!put.ok) {
        throw new Error(`The upload failed (HTTP ${String(put.status)}). Try again.`);
      }
      setStage({
        kind: "attest",
        fontId: ticket.fontId,
        filename: file.name,
        attestation: ticket.attestation,
      });
    } catch (error) {
      setStage({ kind: "error", message: errorMessage(error, "Could not upload that font.") });
    }
  }

  async function onConfirmAttestation(): Promise<void> {
    if (stage.kind !== "attest" || !attested) return;
    setStage({ kind: "finishing", fontId: stage.fontId });
    try {
      await completeUpload.mutateAsync({
        fontId: stage.fontId,
        body: { licenceAttested: true, attestationVersion: stage.attestation.version },
      });
      setStage({ kind: "idle" });
      setAttested(false);
    } catch (error) {
      setStage({ kind: "error", message: errorMessage(error, "Could not finish that font.") });
    }
  }

  return (
    <div className={cn("flex h-full flex-col gap-3", className)} data-testid="custom-fonts-panel">
      <div>
        <h2 className="text-fg-0 text-sm font-medium">Custom fonts</h2>
        <p className="text-fg-2 text-xs">
          Upload a font your brand uses (WOFF2, WOFF, TTF or OTF, up to{" "}
          {String(Math.round(MAX_FONT_UPLOAD_BYTES / (1024 * 1024)))} MB). You warrant you are
          licensed to embed it in exported video.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FONT_EXTENSIONS.join(",")}
        className="sr-only"
        data-testid="custom-fonts-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) void onFileChosen(file);
        }}
      />

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="self-start"
        disabled={busy || stage.kind === "attest"}
        onClick={() => inputRef.current?.click()}
        data-testid="custom-fonts-upload-button"
      >
        {stage.kind === "uploading" ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <Upload aria-hidden="true" />
        )}
        Upload a font
      </Button>

      {stage.kind === "error" ? (
        <p
          role="alert"
          className="border-rejected/40 bg-rejected/10 text-rejected flex items-start gap-1.5 rounded-md border p-2 text-xs"
          data-testid="custom-fonts-error"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {stage.message}
        </p>
      ) : null}

      {stage.kind === "attest" ? (
        <div
          className="border-border flex flex-col gap-2 rounded-md border p-2.5"
          data-testid="custom-fonts-attestation"
        >
          <p className="text-fg-0 text-xs font-medium">{stage.filename}</p>
          <p className="text-fg-2 text-2xs">{stage.attestation.text}</p>
          <label className="text-fg-1 flex items-start gap-1.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={attested}
              data-testid="custom-fonts-attest-checkbox"
              onChange={(event) => setAttested(event.target.checked)}
            />
            I confirm I am licensed to embed this font in exported video.
          </label>
          <div className="flex gap-2">
            <Button
              type="button"
              // Secondary: Export stays the editor's one filled primary.
              variant="secondary"
              size="sm"
              disabled={!attested || stage.kind !== "attest"}
              onClick={() => void onConfirmAttestation()}
              data-testid="custom-fonts-confirm-button"
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Add font
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setStage({ kind: "idle" });
                setAttested(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {fonts.isPending ? (
          <p className="text-fg-2 text-xs">Loading…</p>
        ) : fonts.isError ? (
          <p className="text-rejected text-xs">Could not load your fonts.</p>
        ) : fonts.data.length === 0 ? (
          <p className="text-fg-2 text-xs">No custom fonts yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="custom-fonts-list">
            {fonts.data.map((font) => (
              <FontRow
                key={font.id}
                font={font}
                onDelete={() => deleteFont.mutate(font.id)}
                deleting={deleteFont.isPending && deleteFont.variables === font.id}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FontRow({
  font,
  onDelete,
  deleting,
}: {
  readonly font: WorkspaceFontView;
  readonly onDelete: () => void;
  readonly deleting: boolean;
}): React.JSX.Element {
  return (
    <li
      className="border-border flex items-center gap-2 rounded-md border p-2"
      data-testid="custom-fonts-row"
      data-status={font.status}
    >
      <TypeIcon className="text-fg-2 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-fg-0 truncate text-xs font-medium">{font.family}</p>
        <p className="text-fg-2 text-2xs">
          {font.style} · {formatBytes(font.sizeBytes)}
          {font.scripts.length > 0 ? ` · ${font.scripts.join(", ")}` : ""}
        </p>
      </div>
      {font.status === "ready" ? (
        <Badge className="gap-1">
          <CheckCircle2 className="size-3" aria-hidden="true" />
          Ready
        </Badge>
      ) : font.status === "failed" ? (
        <Badge className="gap-1">Failed</Badge>
      ) : (
        <Badge className="gap-1">Processing…</Badge>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={deleting}
        onClick={onDelete}
        aria-label={`Delete ${font.family}`}
        data-testid="custom-fonts-delete-button"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

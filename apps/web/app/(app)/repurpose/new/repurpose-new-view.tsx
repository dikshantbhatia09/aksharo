"use client";

/**
 * `/repurpose/new` — the calm start screen (REP-008, master plan §3.3).
 *
 * The one rule that shapes this file: **persist the run before any background
 * work begins, then navigate to its own URL** (§3.4). A run that exists only in
 * component state is a run a refresh destroys, and this flow is explicitly built
 * to survive a refresh, a navigation and a closed laptop.
 *
 * The idempotency key belongs to one request BODY, not to the form: a
 * double-clicked button, a flaky connection and a retried request must all land
 * on the same run rather than starting a second transcription — but once the
 * person edits the link after a refusal, the same key with a different body is
 * a conflict the API refuses, so an edited body gets a fresh key.
 */
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import {
  useCreateRepurposeRun,
  useEntitlement,
  type CreateRepurposeRunRequest,
} from "@montaj/api-client";
import { PageHeader } from "@montaj/ui";

import { rememberedLanguage, rememberLanguage } from "@/components/projects/language-picker";
import { describeRefusal } from "@/components/repurpose/refusal";
import { rememberRunSetup, setupOf, startFormFromParams } from "@/components/repurpose/run-setup";
import { normaliseSourceLink } from "@/components/repurpose/source-link";
import { SourceStartForm, type StartFormValue } from "@/components/repurpose/SourceStartForm";
import { useUploadQueue } from "@/lib/upload/use-upload-queue";

/** A key that survives a re-render but changes when the form is genuinely new. */
function newIdempotencyKey(): string {
  return `repurpose-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The key to send with `body`: the last one while the body is unchanged, else a new one. */
export function idempotencyKeyFor(
  last: { readonly key: string; readonly body: string } | null,
  body: string,
): { readonly key: string; readonly body: string } {
  return last !== null && last.body === body ? last : { key: newIdempotencyKey(), body };
}

export function RepurposeNewView(): React.JSX.Element {
  const router = useRouter();
  /*
   * The studio's pipeline banner and `/repurpose` both carry a pasted link
   * here rather than posting a run themselves: a run needs the rights
   * attestation, a spoken language and a style, and none of those can be
   * answered from a one-line field. `?url=` pre-fills the first box; the rest
   * of the form is still the user's to complete, and `rightsAttested` is
   * deliberately NOT pre-filled — a URL in a query string is not consent.
   *
   * A failed run's "Choose another video" / "Check the link" comes here the
   * same way, adding its setup (`lang`, `out`, `script`, `style`, `method`,
   * `n`) so nothing but the video has to be chosen again (`run-setup.ts`).
   * A failed upload run adds `source=upload`, which opens the upload tab.
   */
  const searchParams = useSearchParams();
  const create = useCreateRepurposeRun();
  // The plan's upload cap, so an over-cap file is refused before a run exists.
  // Unknown until the entitlement loads, and never blocking on that.
  const entitlement = useEntitlement();
  const rawCap = Number(entitlement.data?.entitlements["maxFileBytes"]);
  const maxFileBytes = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : undefined;
  // The SAME queue the home drop zone uses. It hashes, initialises, PUTs every
  // part, completes, and lets the existing probe/proxy/transcribe chain take
  // over — so a repurposing upload is an ordinary upload that happens to have a
  // run attached, rather than a second pipeline that has to be kept in step.
  const uploads = useUploadQueue();
  const lastRequest = React.useRef<{ readonly key: string; readonly body: string } | null>(null);
  const [value, setValue] = React.useState<StartFormValue>(() =>
    // The last language they used, the way every other entry point remembers it.
    startFormFromParams(searchParams, rememberedLanguage()),
  );
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [existingRunId, setExistingRunId] = React.useState<string | null>(null);

  const submit = (): void => {
    setServerError(null);
    setExistingRunId(null);
    if (value.sourceLanguage !== undefined) rememberLanguage(value.sourceLanguage);

    const source =
      value.tab === "link"
        ? ({ kind: "url", url: normaliseSourceLink(value.url), rightsAttested: true } as const)
        : ({
            kind: "upload",
            filename: value.file?.name ?? "video.mp4",
            mime: value.file?.type === "" ? "video/mp4" : (value.file?.type ?? "video/mp4"),
            sizeBytes: value.file?.size ?? 0,
            // The queue calls `media/init` itself. Asking for a ticket here too
            // would leave a `pending` media row behind every upload.
            issueUploadTicket: false,
          } as const);

    const body: CreateRepurposeRunRequest = {
      source,
      setup: {
        sourceLanguage: value.sourceLanguage ?? "en",
        caption: {
          outputLanguage: value.outputLanguage,
          scriptMode: value.scriptMode as "auto" | "roman" | "native" | "bilingual",
          styleId: value.styleId,
        },
        discovery: {
          mode: value.method,
          requestedCandidates: value.method === "manual" ? 0 : value.requestedCandidates,
        },
      },
    };
    lastRequest.current = idempotencyKeyFor(lastRequest.current, JSON.stringify(body));

    create.mutate(
      { idempotencyKey: lastRequest.current.key, body },
      {
        onSuccess: (created) => {
          // Kept in this browser so a failed run can offer its setup back
          // ("Choose another video" keeps the look; "Check the link" the link).
          rememberRunSetup(
            created.run.id,
            setupOf({ ...value, url: source.kind === "url" ? source.url : "" }),
          );
          // Start the bytes moving BEFORE navigating. The queue lives in a
          // provider above this route, so it keeps running across the
          // navigation and the upload tray shows its progress the whole way.
          if (value.tab === "upload" && value.file !== null) {
            uploads.addFilesToProjects([{ file: value.file, projectId: created.projectId }], {
              aspect: "9:16",
              ...(value.sourceLanguage === undefined ? {} : { language: value.sourceLanguage }),
              ...(value.styleId === "" ? {} : { styleId: value.styleId }),
            });
          }
          // The run exists server-side before anything else happens, so this
          // navigation is a bookmark, not a handoff of in-memory state.
          router.push(`/repurpose/${created.run.id}`);
        },
        onError: (error) => {
          // Never the API's own message: the same request can be refused by
          // admission or the job ledger, whose wording was not written for a
          // person. A code maps to one sentence (`copy.ts`).
          const refusal = describeRefusal(error, "start");
          setServerError(refusal.text);
          setExistingRunId(refusal.existingRunId ?? null);
        },
      },
    );
  };

  return (
    // A `<div>`, not a second `<main>`: the app shell already provides the
    // page's one main landmark.
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <PageHeader
        eyebrow="Clips pipeline"
        title="Create from a long video"
        description="One long video becomes short, captioned videos you review before anything is posted."
      />

      <div>
        <SourceStartForm
          value={value}
          onChange={setValue}
          onSubmit={submit}
          submitting={create.isPending}
          serverError={serverError}
          existingRunId={existingRunId}
          {...(maxFileBytes === undefined ? {} : { maxFileBytes })}
        />
      </div>
    </div>
  );
}

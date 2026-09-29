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
 *
 * The spoken language starts on "Detect automatically" (`auto`), never on the
 * language this browser last picked on Home: that pick is about other videos,
 * and as a hint it overrides detection — which is how an English video went
 * down the paid Hinglish lane (2026-09-27). A language picked HERE is still
 * remembered for Home, the way every other entry point remembers it.
 *
 * Several at once (2026-10-02, while `repurpose_automations` is on): "Several
 * links" starts one run per link through `POST /repurpose/runs/bulk` and shows
 * each line's outcome here rather than navigating; several files start one
 * upload run each, one after another, then hand every file to the upload queue
 * together - and go to the run list when all of them started.
 */
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import {
  useCreateRepurposeRun,
  useEntitlement,
  useFeatureFlag,
  type CreateRepurposeRunRequest,
} from "@montaj/api-client";
import { PageHeader } from "@montaj/ui";

import { rememberLanguage } from "@/components/projects/language-picker";
import { AUTOMATIONS_FLAG, useBulkRuns } from "@/components/repurpose/automations/use-automations";
import { SOURCE_CEILING_MS } from "@/components/repurpose/failure-detail";
import { describeRefusal } from "@/components/repurpose/refusal";
import {
  recallAutopilot,
  rememberAutopilot,
  rememberRunSetup,
  setupOf,
  startContextFromParams,
  startFormFromParams,
} from "@/components/repurpose/run-setup";
import { runSetupRequest } from "@/components/repurpose/RunSetupFields";
import { linkLinesOf, linksToSend } from "@/components/repurpose/several-links";
import {
  SeveralResults,
  linesOfBulk,
  type SeveralLine,
} from "@/components/repurpose/SeveralResults";
import { normaliseSourceLink } from "@/components/repurpose/source-link";
import {
  DETECT_LANGUAGE,
  SourceStartForm,
  filesOf,
  startAtMs,
  type StartFormValue,
} from "@/components/repurpose/SourceStartForm";
import { useUploadQueue } from "@/lib/upload/use-upload-queue";

/** A positive entitlement number, or `undefined` while unknown or unset. */
function positiveEntitlement(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

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

/** An upload run's source, for one file, as the upload queue will send it. */
function uploadSource(file: File | null): CreateRepurposeRunRequest["source"] {
  return {
    kind: "upload",
    filename: file?.name ?? "video.mp4",
    mime: file?.type === "" ? "video/mp4" : (file?.type ?? "video/mp4"),
    sizeBytes: file?.size ?? 0,
    // The queue calls `media/init` itself. Asking for a ticket here too
    // would leave a `pending` media row behind every upload.
    issueUploadTicket: false,
  } as CreateRepurposeRunRequest["source"];
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
  const bulk = useBulkRuns();
  // Several links and several files, while the feature is on for this workspace.
  const allowSeveral = useFeatureFlag(AUTOMATIONS_FLAG);
  // The plan's upload cap, so an over-cap file is refused before a run exists.
  // Unknown until the entitlement loads, and never blocking on that.
  const entitlement = useEntitlement();
  const maxFileBytes = positiveEntitlement(entitlement.data?.entitlements["maxFileBytes"]);
  // How much of a video a run processes, for the line under "Start at".
  const clipsWindowMs = positiveEntitlement(entitlement.data?.entitlements["clipsWindowMs"]);
  // A window that reaches the source ceiling (the owner's internal unlimited
  // workspace) processes every video it takes whole, and the downloader then
  // ignores a start: the field is not offered, rather than a line saying
  // "videos over 12 hours are processed 12 hours at a time".
  const ceilingMs =
    positiveEntitlement(entitlement.data?.entitlements["maxSourceDurationMs"]) ?? SOURCE_CEILING_MS;
  const processesWholeVideos =
    entitlement.data?.entitlements["internalUnlimited"] === true ||
    (clipsWindowMs !== undefined && clipsWindowMs >= ceilingMs);
  const planWindowMs = processesWholeVideos ? undefined : clipsWindowMs;
  // The SAME queue the home drop zone uses. It hashes, initialises, PUTs every
  // part, completes, and lets the existing probe/proxy/transcribe chain take
  // over — so a repurposing upload is an ordinary upload that happens to have a
  // run attached, rather than a second pipeline that has to be kept in step.
  const uploads = useUploadQueue();
  const lastRequest = React.useRef<{ readonly key: string; readonly body: string } | null>(null);
  const [value, setValue] = React.useState<StartFormValue>(() =>
    // A failed run's own setup when it sent one; otherwise detect.
    startFormFromParams(searchParams, DETECT_LANGUAGE),
  );
  // Read once, like the form: the URL does not change under this page.
  const [startContext] = React.useState(() => startContextFromParams(searchParams));
  // The Autopilot choice this browser made last, once mounted (storage is
  // not read during render, so the server's form and the first paint agree).
  React.useEffect(() => {
    const on = recallAutopilot();
    setValue((current) => (current.autopilot === on ? current : { ...current, autopilot: on }));
  }, []);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [existingRunId, setExistingRunId] = React.useState<string | null>(null);
  const [seeCredits, setSeeCredits] = React.useState(false);
  const [severalLines, setSeveralLines] = React.useState<readonly SeveralLine[] | null>(null);
  const [startingFiles, setStartingFiles] = React.useState(false);

  const files = filesOf(value);
  const linkCount = value.tab === "links" ? linksToSend(linkLinesOf(value.links)).length : 0;
  const submitLabel =
    value.tab === "links" && linkCount > 1
      ? `Start ${String(linkCount)} runs`
      : value.tab === "upload" && files.length > 1
        ? `Start ${String(files.length)} runs`
        : undefined;

  const refuse = (error: unknown): void => {
    // Never the API's own message: the same request can be refused by
    // admission or the job ledger, whose wording was not written for a
    // person. A code maps to one sentence (`copy.ts`).
    const refusal = describeRefusal(error, "start");
    setServerError(refusal.text);
    setExistingRunId(refusal.existingRunId ?? null);
    setSeeCredits(refusal.seeCredits === true);
  };

  /** The queue's quick pick for uploads started here. */
  const quickPick = (): Parameters<typeof uploads.addFilesToProjects>[1] => {
    const pickedLanguage =
      value.sourceLanguage === DETECT_LANGUAGE ? undefined : value.sourceLanguage;
    return {
      aspect: "9:16",
      // A picked language lets the queue ask for the transcript the moment
      // the file lands. "Detect" is left to the server, which starts it once
      // the video is prepared: the queue's eager request would send `auto`
      // where a language tag is expected.
      ...(pickedLanguage === undefined ? {} : { language: pickedLanguage }),
      ...(value.styleId === "" ? {} : { styleId: value.styleId }),
    };
  };

  /** Several links: one bulk request, its outcome line by line, no navigation. */
  const submitLinks = (): void => {
    const body = {
      links: linksToSend(linkLinesOf(value.links)),
      setup: runSetupRequest(value),
      rightsAttested: true as const,
    };
    lastRequest.current = idempotencyKeyFor(lastRequest.current, JSON.stringify(body));
    bulk.mutate(
      { body, idempotencyKey: lastRequest.current.key },
      {
        onSuccess: (response) => {
          setSeveralLines(linesOfBulk(response.results));
        },
        onError: refuse,
      },
    );
  };

  /**
   * Several files: a run each, one after another (each is one request the plan
   * already admits), then every started file to the queue together. All
   * started: the run list, where they all are. Otherwise the outcome stays
   * here, and the form keeps only the files that did not start, for another try.
   */
  const submitFiles = async (): Promise<void> => {
    setStartingFiles(true);
    const setup = runSetupRequest(value);
    const lines: SeveralLine[] = [];
    const pairs: { file: File; projectId: string }[] = [];
    const failed: File[] = [];
    for (const [index, file] of files.entries()) {
      try {
        const created = await create.mutateAsync({
          idempotencyKey: newIdempotencyKey(),
          body: { source: uploadSource(file), setup },
        });
        pairs.push({ file, projectId: created.projectId });
        rememberRunSetup(created.run.id, setupOf({ ...value, url: "" }));
        lines.push({
          key: `file-${String(index)}`,
          label: file.name,
          outcome: "started",
          runId: created.run.id,
          text: "Started",
        });
      } catch (error) {
        failed.push(file);
        lines.push({
          key: `file-${String(index)}`,
          label: file.name,
          outcome: "refused",
          runId: null,
          text: describeRefusal(error, "start").text,
        });
      }
    }
    // Start the bytes moving BEFORE navigating: the queue keeps running.
    if (pairs.length > 0) uploads.addFilesToProjects(pairs, quickPick());
    setStartingFiles(false);
    if (failed.length === 0) {
      router.push("/repurpose");
      return;
    }
    setSeveralLines(lines);
    setValue((current) => ({ ...current, file: failed[0] ?? null, files: failed }));
  };

  const submit = (): void => {
    setServerError(null);
    setExistingRunId(null);
    setSeeCredits(false);
    setSeveralLines(null);
    // "Detect" is not a language, and Home's picker has no such entry.
    const pickedLanguage =
      value.sourceLanguage === DETECT_LANGUAGE ? undefined : value.sourceLanguage;
    if (pickedLanguage !== undefined) rememberLanguage(pickedLanguage);
    rememberAutopilot(value.autopilot);

    if (value.tab === "links") {
      submitLinks();
      return;
    }
    if (value.tab === "upload" && files.length > 1) {
      void submitFiles();
      return;
    }

    // No start where none is offered: a `start=` carried in the URL would
    // otherwise be sent, unseen, by a plan that processes videos whole.
    const sent: StartFormValue = processesWholeVideos ? { ...value, startAt: "" } : value;
    const startMs = startAtMs(sent);

    const source =
      value.tab === "link"
        ? ({ kind: "url", url: normaliseSourceLink(value.url), rightsAttested: true } as const)
        : uploadSource(value.file);

    const setup: CreateRepurposeRunRequest["setup"] = {
      ...runSetupRequest(value),
      // Only with a start: no window leaves the choice to the server.
      ...(startMs === undefined ? {} : { window: { startMs, policy: "range" as const } }),
    };
    const body: CreateRepurposeRunRequest = { source, setup };
    lastRequest.current = idempotencyKeyFor(lastRequest.current, JSON.stringify(body));

    create.mutate(
      { idempotencyKey: lastRequest.current.key, body },
      {
        onSuccess: (created) => {
          // Kept in this browser so a failed run can offer its setup back
          // ("Choose another video" keeps the look; "Check the link" the link).
          rememberRunSetup(
            created.run.id,
            setupOf({ ...sent, url: source.kind === "url" ? source.url : "" }),
          );
          // Start the bytes moving BEFORE navigating. The queue lives in a
          // provider above this route, so it keeps running across the
          // navigation and the upload tray shows its progress the whole way.
          if (value.tab === "upload" && value.file !== null) {
            uploads.addFilesToProjects(
              [{ file: value.file, projectId: created.projectId }],
              quickPick(),
            );
          }
          // The run exists server-side before anything else happens, so this
          // navigation is a bookmark, not a handoff of in-memory state.
          router.push(`/repurpose/${created.run.id}`);
        },
        onError: refuse,
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

      <div className="flex flex-col gap-6">
        <SourceStartForm
          value={value}
          onChange={setValue}
          onSubmit={submit}
          submitting={create.isPending || bulk.isPending || startingFiles}
          serverError={serverError}
          existingRunId={existingRunId}
          seeCredits={seeCredits}
          focusStartAt={startContext.focusStartAt}
          allowSeveral={allowSeveral}
          {...(submitLabel === undefined ? {} : { submitLabel })}
          {...(maxFileBytes === undefined ? {} : { maxFileBytes })}
          {...(planWindowMs === undefined ? {} : { planWindowMs })}
          processesWholeVideos={processesWholeVideos}
          // The length holds only while the link is still the one it came
          // with (`validateStartForm`).
          {...(startContext.knownLength === undefined
            ? {}
            : { knownLength: startContext.knownLength })}
        />
        {severalLines === null ? null : <SeveralResults lines={severalLines} />}
      </div>
    </div>
  );
}

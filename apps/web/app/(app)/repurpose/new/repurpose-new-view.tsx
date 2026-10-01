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
 *
 * A cover for an audio file's clips (2026-10-04, audiograms) is uploaded first,
 * before any run is created, so every run it is for can name it
 * (`setup.audiogram.coverAssetId`); a cover the API refuses stops the start
 * with its reason, and nothing is created.
 *
 * "See a finished example" (2026-10-01) sits under the title while the owner
 * has set an example run (`ExampleRunLink`; nothing renders otherwise), for
 * the person who wants to see what a run makes before starting one.
 *
 * Captions the person already has (2026-10-01): for one video, the picked SRT
 * or VTT file is read here and sent with the run as its text (or the link to
 * one is sent), and the run aligns them instead of transcribing.
 */
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import {
  useCreateRepurposeRun,
  useEntitlement,
  useFeatureFlag,
  useStyles,
  type CreateRepurposeRunRequest,
} from "@montaj/api-client";
import { PageHeader } from "@montaj/ui";

import { useBrandKit } from "@/components/brand-kit/use-brand-kit";
import { brollOfferOf, useBrollLibrary } from "@/components/broll/use-broll-library";
import { rememberLanguage } from "@/components/projects/language-picker";
import { AUTOMATIONS_FLAG, useBulkRuns } from "@/components/repurpose/automations/use-automations";
import { ExampleRunLink } from "@/components/repurpose/example/ExampleRunLink";
import { SOURCE_CEILING_MS } from "@/components/repurpose/failure-detail";
import { describeRefusal } from "@/components/repurpose/refusal";
import { useRunDefaults } from "@/components/repurpose/results/use-results";
import { captionsToSend, givesCaptions } from "@/components/repurpose/run-captions";
import {
  carriesSetup,
  recallAutopilot,
  rememberAutopilot,
  rememberRunSetup,
  setupOf,
  startContextFromParams,
  startFormFromParams,
} from "@/components/repurpose/run-setup";
import { RunDefaultsControl } from "@/components/repurpose/RunDefaultsControl";
import { RunEstimateLine } from "@/components/repurpose/RunEstimateLine";
import { runSetupRequest, runSetupValueOf } from "@/components/repurpose/RunSetupFields";
import { linkLinesOf, linksToSend } from "@/components/repurpose/several-links";
import {
  SeveralResults,
  linesOfBulk,
  type SeveralLine,
} from "@/components/repurpose/SeveralResults";
import { normaliseSourceLink } from "@/components/repurpose/source-link";
import {
  DETECT_LANGUAGE,
  RECOMMENDED_STYLES,
  SourceStartForm,
  coverToSend,
  filesOf,
  startAtMs,
  type StartFormValue,
} from "@/components/repurpose/SourceStartForm";
import { useUploadCover } from "@/components/repurpose/use-cover";
import { useUploadQueue } from "@/lib/upload/use-upload-queue";

/** YouTube links: without them there is nothing for "Several links" to start. */
const YOUTUBE_FLAG = "source_youtube_acquire";

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

/** A run's setup with the cover its audio file's clips are drawn with, when there is one. */
function withCover(
  setup: CreateRepurposeRunRequest["setup"],
  coverAssetId: string | undefined,
): CreateRepurposeRunRequest["setup"] {
  return coverAssetId === undefined ? setup : { ...setup, audiogram: { coverAssetId } };
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
  // Several files while the feature is on for this workspace; several links
  // when YouTube links are on too (the bulk route answers 404 otherwise).
  const allowSeveralFiles = useFeatureFlag(AUTOMATIONS_FLAG);
  const allowSeveralLinks = useFeatureFlag(YOUTUBE_FLAG) && allowSeveralFiles;
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
  // The longest file an upload may be (the probe refuses a longer one), for
  // the cost line's warning; none for the internal unlimited workspace.
  const maxUploadMs =
    entitlement.data?.entitlements["internalUnlimited"] === true
      ? undefined
      : positiveEntitlement(entitlement.data?.entitlements["maxDurationMs"]);
  // The SAME queue the home drop zone uses. It hashes, initialises, PUTs every
  // part, completes, and lets the existing probe/proxy/transcribe chain take
  // over — so a repurposing upload is an ordinary upload that happens to have a
  // run attached, rather than a second pipeline that has to be kept in step.
  const uploads = useUploadQueue();
  // The brand kit (2026-10-02): the switch is offered once one is saved.
  const brandKit = useBrandKit();
  const hasBrandKit = brandKit.data?.exists === true;
  // B-roll (2026-10-05): offered when the library has pictures, or stock photos are set up.
  const broll = brollOfferOf(useBrollLibrary().data);
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
  // The workspace's saved default setup (2026-10-01), once it arrives: the
  // form opens on it, unless the URL brought a setup of its own (a failed
  // run's) or the person has already changed something.
  const runDefaults = useRunDefaults();
  // The workspace's own caption looks (2026-10-01), saved from the editor.
  const stylesQuery = useStyles();
  const presets = React.useMemo(
    () =>
      (stylesQuery.data ?? [])
        .filter((entry) => entry.source === "custom")
        .map((entry) => ({ id: entry.id, name: entry.name })),
    [stylesQuery.data],
  );
  const touched = React.useRef(false);
  const defaultsApplied = React.useRef(carriesSetup(searchParams));
  React.useEffect(() => {
    const saved = runDefaults.data?.setup;
    if (defaultsApplied.current || touched.current || saved === undefined) return;
    const next = saved === null ? null : runSetupValueOf(saved);
    const system = next !== null && RECOMMENDED_STYLES.some((style) => style.id === next.styleId);
    // A saved look of the workspace's own is known once its looks have loaded.
    if (next !== null && !system && stylesQuery.isPending) return;
    defaultsApplied.current = true;
    if (next === null) return;
    const known = system || presets.some((preset) => preset.id === next.styleId);
    setValue((current) => ({
      ...current,
      ...next,
      // A look no longer offered is not shown as chosen: the form keeps its own.
      styleId: known ? next.styleId : current.styleId,
    }));
  }, [runDefaults.data, stylesQuery.isPending, presets]);
  const change = React.useCallback((next: StartFormValue) => {
    touched.current = true;
    setValue(next);
  }, []);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [existingRunId, setExistingRunId] = React.useState<string | null>(null);
  const [seeCredits, setSeeCredits] = React.useState(false);
  const [severalLines, setSeveralLines] = React.useState<readonly SeveralLine[] | null>(null);
  const [startingFiles, setStartingFiles] = React.useState(false);
  const uploadCover = useUploadCover();

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
    // A run with its own captions (2026-10-01) is never transcribed: the queue
    // is not given a language, so it asks for no paid transcript either.
    const pickedLanguage =
      value.sourceLanguage === DETECT_LANGUAGE || givesCaptions(value)
        ? undefined
        : value.sourceLanguage;
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

  /**
   * The cover picked for an audio file, uploaded before anything else
   * (2026-10-04): its asset id, `undefined` when none was picked, or `null`
   * when it was refused - the refusal is then on the form, and nothing starts.
   */
  const coverFirst = async (): Promise<string | undefined | null> => {
    const cover = coverToSend(value);
    if (cover === null) return undefined;
    try {
      return (await uploadCover.mutateAsync(cover)).assetId;
    } catch (error) {
      refuse(error);
      return null;
    }
  };

  /** Several links: one bulk request, its outcome line by line, no navigation. */
  const submitLinks = (): void => {
    const body = {
      links: linksToSend(linkLinesOf(value.links)),
      setup: runSetupRequest(value, {
        brandKit: hasBrandKit,
        ...(broll === undefined ? {} : { broll }),
      }),
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
    const cover = await coverFirst();
    if (cover === null) {
      setStartingFiles(false);
      return;
    }
    const setup = withCover(
      runSetupRequest(value, { brandKit: hasBrandKit, ...(broll === undefined ? {} : { broll }) }),
      cover,
    );
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
      ...runSetupRequest(value, {
        brandKit: hasBrandKit,
        ...(broll === undefined ? {} : { broll }),
      }),
      // Only with a start: no window leaves the choice to the server.
      ...(startMs === undefined ? {} : { window: { startMs, policy: "range" as const } }),
    };
    // The person's own captions (2026-10-01) are read from the file first; a
    // file that cannot be read stops the start with a plain reason.
    setStartingFiles(true);
    void captionsToSend(sent)
      .then((captions) => {
        const captioned = captions === undefined ? setup : { ...setup, captions };
        // An audio file's cover goes up first (2026-10-04); none, and this is
        // the same start as ever.
        if (value.tab === "upload" && coverToSend(value) !== null) {
          void coverFirst().then((cover) => {
            setStartingFiles(false);
            if (cover !== null) startOne(source, withCover(captioned, cover), sent);
          });
          return;
        }
        setStartingFiles(false);
        startOne(source, captioned, sent);
      })
      .catch(() => {
        setStartingFiles(false);
        setServerError("That caption file could not be read. Choose it again, or remove it.");
      });
  };

  /** Creates the one run the form describes, and goes to it. */
  const startOne = (
    source: CreateRepurposeRunRequest["source"],
    setup: CreateRepurposeRunRequest["setup"],
    sent: StartFormValue,
  ): void => {
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
      <ExampleRunLink withHint className="-mt-4" />

      <div className="flex flex-col gap-6">
        <SourceStartForm
          value={value}
          onChange={change}
          onSubmit={submit}
          submitting={create.isPending || bulk.isPending || startingFiles}
          serverError={serverError}
          existingRunId={existingRunId}
          seeCredits={seeCredits}
          focusStartAt={startContext.focusStartAt}
          allowSeveralLinks={allowSeveralLinks}
          allowSeveralFiles={allowSeveralFiles}
          {...(submitLabel === undefined ? {} : { submitLabel })}
          {...(maxFileBytes === undefined ? {} : { maxFileBytes })}
          {...(planWindowMs === undefined ? {} : { planWindowMs })}
          processesWholeVideos={processesWholeVideos}
          brandKit={hasBrandKit}
          {...(broll === undefined ? {} : { broll })}
          // The length holds only while the link is still the one it came
          // with (`validateStartForm`).
          {...(startContext.knownLength === undefined
            ? {}
            : { knownLength: startContext.knownLength })}
          presets={presets}
          defaultsControl={
            <RunDefaultsControl
              value={value}
              brandKit={hasBrandKit}
              {...(broll === undefined ? {} : { broll })}
            />
          }
          estimate={
            <RunEstimateLine
              value={value}
              {...(startContext.knownLength === undefined
                ? {}
                : { knownLength: startContext.knownLength })}
              {...(maxUploadMs === undefined ? {} : { maxUploadMs })}
            />
          }
        />
        {severalLines === null ? null : <SeveralResults lines={severalLines} />}
      </div>
    </div>
  );
}

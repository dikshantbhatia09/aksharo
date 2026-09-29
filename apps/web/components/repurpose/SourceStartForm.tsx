"use client";

/**
 * Stage 1 — "Add video" (REP-008, master plan §3.3).
 *
 * Two equal tabs converging on one setup panel, because the choices below are
 * the same whether the video was pasted or uploaded. What is deliberately NOT
 * here: aspect ratios, audio enhancement, emojis, B-roll, music, voice-over,
 * every network, and model controls. Those belong to later stages or to
 * Advanced settings, and putting them on the first screen is how a beginner flow
 * stops being one.
 *
 * Client validation is a courtesy, not a control: the API revalidates every
 * field, normalises the URL itself (REP-009) and records the attestation with a
 * timestamp. Nothing here is trusted server-side.
 *
 * Accessibility notes, because two of them were got wrong the first time:
 *
 *   * the two pickers render their own `<button>` with their own `aria-label`
 *     and accept no `id`, so a `<label for=…>` beside them points at nothing.
 *     They are wrapped in a labelled `role="group"` instead, and the VISIBLE
 *     text is the same string as the picker's `aria-label` — WCAG 2.5.3 Label
 *     in Name is about the visible name being IN the accessible one;
 *   * the two chip/radio groups are real `<fieldset><legend>`, so each group has
 *     a programmatic name rather than a floating `<Label>` with no control;
 *   * every field error is rendered through `Field`'s own `error` slot and
 *     referenced by `aria-describedby`, so the message reaches a screen reader
 *     attached to the control rather than as a detached alert.
 *
 * Two things changed on 2026-09-27 with the plan limits. A plan now limits the
 * minutes a run processes, not the video's length, so a link has an optional
 * "Start at": a long video is processed a part at a time, the most-replayed
 * part unless the person says where to start. And the spoken language starts
 * on "Detect automatically": the form used to pre-fill it from whatever this
 * browser last picked on Home, and that hint overrides detection — an English
 * video went down the paid Hinglish lane because of an unrelated earlier pick.
 *
 * Several at once (2026-10-02, while `repurpose_automations` is on): a third tab
 * takes up to twenty links, one per line (`allowSeveralLinks`, which needs
 * YouTube links on too), and the upload tab takes several files
 * (`allowSeveralFiles`). Each becomes its own run with the one setup below. The
 * setup panel itself is `RunSetupFields`, shared with the Automations page.
 */
import NextLink from "next/link";
import * as React from "react";

import { Button, Field, Input, Textarea, cn } from "@montaj/ui";

import { DETAIL_COPY } from "@/components/repurpose/copy";
import { SOURCE_CEILING_MS, formatBytes, spanPhrase } from "@/components/repurpose/failure-detail";
import { formatClock, parseClock } from "@/components/repurpose/moment-time";
import {
  EMPTY_RUN_SETUP,
  RunSetupFields,
  validateRunSetup,
  type RunSetupProblems,
  type RunSetupValue,
} from "@/components/repurpose/RunSetupFields";
import {
  MAX_LINKS,
  linkLinesOf,
  linksToSend,
  severalLinksProblem,
} from "@/components/repurpose/several-links";
import { isPlausibleLink, normaliseSourceLink } from "@/components/repurpose/source-link";

export {
  DEFAULT_STYLE_ID,
  DETECT_LANGUAGE,
  RECOMMENDED_STYLES,
} from "@/components/repurpose/RunSetupFields";

/** Files one start may take at once: the same twenty as links. */
export const MAX_FILES = MAX_LINKS;

export interface StartFormValue extends RunSetupValue {
  /** One link, several links (one per line), or files from the device. */
  readonly tab: "link" | "links" | "upload";
  readonly url: string;
  /** The "Several links" box, as typed: one link per line. */
  readonly links: string;
  /**
   * Where a long video's window starts, as typed (`m:ss` or `h:mm:ss`); empty
   * leaves it to the server (the most-replayed part, else the start). Links
   * only: an upload is processed whole, within the plan's upload limit.
   */
  readonly startAt: string;
  /** The file picked, or the first of several. */
  readonly file: File | null;
  /** Every file picked, when several may be (`allowSeveralFiles`); empty otherwise. */
  readonly files: readonly File[];
  readonly rightsAttested: boolean;
}

export const EMPTY_START_FORM: StartFormValue = Object.freeze({
  ...EMPTY_RUN_SETUP,
  tab: "link",
  url: "",
  links: "",
  startAt: "",
  file: null,
  files: [],
  rightsAttested: false,
});

export interface StartFormProblems extends RunSetupProblems {
  readonly url?: string;
  readonly links?: string;
  readonly startAt?: string;
  readonly file?: string;
  readonly rights?: string;
}

/**
 * The typed "Start at" in milliseconds, or `undefined` when there is none to
 * send: an upload, an empty field, or text that is not a time (which
 * {@link validateStartForm} refuses before anything is sent).
 */
export function startAtMs(value: Pick<StartFormValue, "tab" | "startAt">): number | undefined {
  if (value.tab !== "link" || value.startAt.trim() === "") return undefined;
  return parseClock(value.startAt) ?? undefined;
}

/** The files the upload tab holds: every one picked, or the one. */
export function filesOf(value: Pick<StartFormValue, "file" | "files">): readonly File[] {
  if (value.files.length > 0) return value.files;
  return value.file === null ? [] : [value.file];
}

/**
 * A video's length the page already knows, and the link it belongs to: a
 * too-long run's "Pick where to start" carries both.
 */
export interface KnownLength {
  readonly link: string;
  readonly durationMs: number;
}

/**
 * Everything wrong with the form right now, keyed by field.
 *
 * `maxFileBytes` is the plan's upload cap, when the entitlement has loaded. An
 * upload over it used to create a run first and only then be refused by the
 * upload itself, leaving a run on "Getting your video" for ever (clips
 * hardening, 2026-09-26); now it is refused here, before anything exists.
 *
 * `knownLength` is the video's length when the page already knows it, so a
 * start past the end is refused at the field rather than by the download. It
 * holds only while the link is still that video's: replaced by another link,
 * it would refuse a good start with the wrong video's length. Known or not, a
 * start at or past the 12-hour ceiling is a typo no video can satisfy, and is
 * refused here rather than as the API's "something in the form was not
 * accepted".
 */
export function validateStartForm(
  value: StartFormValue,
  limits: { readonly maxFileBytes?: number; readonly knownLength?: KnownLength } = {},
): StartFormProblems {
  const problems: { -readonly [K in keyof StartFormProblems]: string } = {};
  const cap = limits.maxFileBytes;

  if (value.tab === "link") {
    // Validate what will be SENT: a scheme-less or http link is normalised to
    // https first, the way `/repurpose` and Home already let people paste it.
    const url = normaliseSourceLink(value.url);
    if (url === "") problems.url = "Paste a link to your video.";
    else if (!isPlausibleLink(url)) {
      problems.url = "Paste the link to one YouTube video, like youtube.com/watch?v=…";
    }
    if (value.startAt.trim() !== "") {
      const start = parseClock(value.startAt);
      const known = limits.knownLength;
      const length =
        known !== undefined && url !== "" && normaliseSourceLink(known.link) === url
          ? known.durationMs
          : undefined;
      if (start === null) problems.startAt = "Type the start as m:ss or h:mm:ss, like 12:10.";
      else if (start >= SOURCE_CEILING_MS) {
        problems.startAt = DETAIL_COPY.startPastCeiling(spanPhrase(SOURCE_CEILING_MS));
      } else if (length !== undefined && length > 0 && start >= length) {
        problems.startAt = DETAIL_COPY.startPastEnd(formatClock(length));
      }
    }
    if (!value.rightsAttested) {
      problems.rights = "Please confirm you own this video or have permission to use it.";
    }
  } else if (value.tab === "links") {
    const links = severalLinksProblem(linkLinesOf(value.links));
    if (links !== undefined) problems.links = links;
    if (!value.rightsAttested) {
      problems.rights = "Please confirm you own these videos or have permission to use them.";
    }
  } else {
    const files = filesOf(value);
    if (files.length === 0) {
      problems.file = "Choose a video from your device.";
    } else if (files.length > MAX_FILES) {
      problems.file = `Up to ${String(MAX_FILES)} videos at a time.`;
    } else if (cap !== undefined && Number.isFinite(cap) && cap > 0) {
      const over = files.find((file) => file.size > cap);
      if (over !== undefined) {
        problems.file =
          files.length === 1
            ? `This file is larger than your plan allows (up to ${formatBytes(cap)}). Choose a smaller copy.`
            : `${over.name} is larger than your plan allows (up to ${formatBytes(cap)}). Choose a smaller copy.`;
      }
    }
  }

  return { ...problems, ...validateRunSetup(value) };
}

export interface SourceStartFormProps {
  readonly value: StartFormValue;
  readonly onChange: (next: StartFormValue) => void;
  readonly onSubmit: () => void;
  readonly submitting?: boolean;
  /** A server-side refusal, already in plain language. */
  readonly serverError?: string | null;
  /**
   * The live run this link already belongs to, when the refusal was "you are
   * already working on this video": the way out is that run, not a dead end.
   */
  readonly existingRunId?: string | null;
  /** The refusal was for credits: link to the balance beside it. */
  readonly seeCredits?: boolean;
  /** The plan's upload cap, once known; an upload over it is refused here. */
  readonly maxFileBytes?: number;
  /** How much of a video the plan processes per run, once known. */
  readonly planWindowMs?: number;
  /**
   * The plan's window reaches the source ceiling (the owner's unlimited
   * workspace): every video it takes is processed whole, which ignores any
   * start, so "Start at" is not offered at all rather than doing nothing.
   */
  readonly processesWholeVideos?: boolean;
  /** The video's length and its link, when the page came from a run that learned it. */
  readonly knownLength?: KnownLength;
  /** Put the cursor in "Start at": the person came here to pick a start. */
  readonly focusStartAt?: boolean;
  /**
   * Offer the "Several links" tab. Off (with {@link allowSeveralFiles}), the
   * form is exactly the one-video form it always was.
   */
  readonly allowSeveralLinks?: boolean;
  /** Let the upload tab take several files, one run each. */
  readonly allowSeveralFiles?: boolean;
  /** Replaces the submit button's label (the page says how many runs it starts). */
  readonly submitLabel?: string;
  /** The workspace has a saved brand kit (2026-10-02): the brand switch is offered. */
  readonly brandKit?: boolean;
  readonly className?: string;
}

const TAB_LABELS: Readonly<Record<StartFormValue["tab"], string>> = Object.freeze({
  link: "Paste a link",
  links: "Several links",
  upload: "Upload a video",
});

export function SourceStartForm({
  value,
  onChange,
  onSubmit,
  submitting = false,
  serverError = null,
  existingRunId = null,
  seeCredits = false,
  maxFileBytes,
  planWindowMs,
  processesWholeVideos = false,
  knownLength,
  focusStartAt = false,
  allowSeveralLinks = false,
  allowSeveralFiles = false,
  submitLabel,
  brandKit = false,
  className,
}: SourceStartFormProps): React.JSX.Element {
  const [showProblems, setShowProblems] = React.useState(false);
  const startAtRef = React.useRef<HTMLInputElement>(null);
  // A start is not checked where it is not offered: a hidden field's error
  // would block the form with nothing to correct.
  const problems = validateStartForm(processesWholeVideos ? { ...value, startAt: "" } : value, {
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    ...(knownLength === undefined ? {} : { knownLength }),
  });
  const visible: StartFormProblems = showProblems ? problems : {};
  const lines = value.tab === "links" ? linkLinesOf(value.links) : [];
  const files = filesOf(value);

  React.useEffect(() => {
    // On arrival from "Pick where to start": the prop comes from the URL and
    // does not change afterwards, so this runs once, not on every keystroke.
    if (focusStartAt) startAtRef.current?.focus();
  }, [focusStartAt]);

  const set = <K extends keyof StartFormValue>(key: K, next: StartFormValue[K]): void => {
    onChange({ ...value, [key]: next });
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    onSubmit();
  };

  const tabs: readonly StartFormValue["tab"][] = allowSeveralLinks
    ? ["link", "links", "upload"]
    : ["link", "upload"];
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  // Arrow keys move between the tabs, as a tablist promises (roving focus).
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, tabs.indexOf(value.tab));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    // eslint-disable-next-line security/detect-object-injection -- bounded index into a literal tuple
    const tab = tabs[next] ?? "link";
    set("tab", tab);
    // eslint-disable-next-line security/detect-object-injection -- key is one of the tab literals
    tabRefs.current[tab]?.focus();
  };

  const several = value.tab === "links";
  const rights = (
    <div>
      {/* The whole row is the hit target, not just the 16 px box. */}
      <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-fg-1">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-accent"
          checked={value.rightsAttested}
          data-testid="rights-attested"
          aria-invalid={visible.rights !== undefined}
          aria-describedby={visible.rights === undefined ? undefined : "repurpose-rights-error"}
          onChange={(event) => {
            set("rightsAttested", event.target.checked);
          }}
        />
        <span>
          {several
            ? "I own these videos or have permission to use them."
            : "I own this video or have permission to use it."}
        </span>
      </label>
      {visible.rights !== undefined && (
        <p
          id="repurpose-rights-error"
          role="alert"
          className="mt-1 text-xs text-rejected"
          data-testid="error-rights"
        >
          {visible.rights}
        </p>
      )}
    </div>
  );

  return (
    // `noValidate`: the browser's own `type="url"` check blocks a scheme-less
    // link before `validateStartForm` can normalise it, and says so in a
    // tooltip no screen reader is pointed at.
    <form
      onSubmit={submit}
      noValidate
      data-testid="repurpose-start-form"
      className={cn("space-y-6", className)}
    >
      <section className="space-y-4" aria-labelledby="repurpose-source-heading">
        <h2 id="repurpose-source-heading" className="text-base text-fg-0">
          {several || files.length > 1 ? "Your videos" : "Your video"}
        </h2>
        {/* Equal tabs — none is the "real" one (§3.3). Underline indicator
            per the Shirorekha tab recipe. */}
        <div
          role="tablist"
          aria-label="Where your video comes from"
          className="flex border-b border-border"
        >
          {tabs.map((tab) => {
            const selected = value.tab === tab;
            return (
              <button
                key={tab}
                ref={(node) => {
                  // eslint-disable-next-line security/detect-object-injection -- key is one of the tab literals
                  tabRefs.current[tab] = node;
                }}
                type="button"
                role="tab"
                id={`repurpose-tab-${tab}`}
                aria-selected={selected}
                aria-controls={`repurpose-panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                data-testid={`source-tab-${tab}`}
                onClick={() => {
                  set("tab", tab);
                }}
                onKeyDown={onTabKeyDown}
                className={cn(
                  "-mb-px h-10 min-w-0 flex-1 truncate border-b-2 px-2 font-medium transition-colors duration-[160ms] sm:px-4",
                  // Three tabs share a phone's width: a size smaller there, not a wrapped label.
                  tabs.length > 2 ? "text-xs sm:text-sm" : "text-sm",
                  selected
                    ? "border-accent text-fg-0"
                    : "border-transparent text-fg-2 hover:text-fg-0",
                )}
              >
                {/* eslint-disable-next-line security/detect-object-injection -- one of the tab literals */}
                {TAB_LABELS[tab]}
              </button>
            );
          })}
        </div>

        {value.tab === "link" ? (
          <div
            role="tabpanel"
            id="repurpose-panel-link"
            aria-labelledby="repurpose-tab-link"
            className="space-y-3"
          >
            <Field
              label="Video link"
              htmlFor="repurpose-url"
              hint="A YouTube link. To use a file from somewhere else, upload it."
              {...(visible.url === undefined ? {} : { error: visible.url })}
            >
              <Input
                id="repurpose-url"
                type="url"
                inputMode="url"
                className="bg-sunken"
                placeholder="https://www.youtube.com/watch?v=…"
                value={value.url}
                data-testid="source-url"
                aria-invalid={visible.url !== undefined}
                // The message is attached to the control, not floating beside it.
                aria-describedby={
                  visible.url === undefined ? "repurpose-url-hint" : "repurpose-url-error"
                }
                onChange={(event) => {
                  set("url", event.target.value);
                }}
              />
            </Field>

            {/* Optional, and a plain time field: most people never need it, and
                the line under it says when it applies and what happens when it
                is left empty. */}
            {processesWholeVideos ? null : (
              <Field
                label="Start at (optional)"
                htmlFor="repurpose-start-at"
                hint={DETAIL_COPY.windowLine(
                  planWindowMs === undefined ? undefined : spanPhrase(planWindowMs),
                )}
                {...(visible.startAt === undefined ? {} : { error: visible.startAt })}
              >
                <Input
                  ref={startAtRef}
                  id="repurpose-start-at"
                  // No numeric keypad: most of them have no ":" to type.
                  autoComplete="off"
                  className="w-32 bg-sunken font-mono"
                  placeholder="0:00"
                  value={value.startAt}
                  data-testid="source-start-at"
                  aria-invalid={visible.startAt !== undefined}
                  aria-describedby={
                    visible.startAt === undefined
                      ? "repurpose-start-at-hint"
                      : "repurpose-start-at-error"
                  }
                  onChange={(event) => {
                    set("startAt", event.target.value);
                  }}
                />
              </Field>
            )}

            {rights}
          </div>
        ) : value.tab === "links" ? (
          <div
            role="tabpanel"
            id="repurpose-panel-links"
            aria-labelledby="repurpose-tab-links"
            className="space-y-3"
          >
            <Field
              label="Video links"
              htmlFor="repurpose-links"
              hint={`One YouTube link per line, up to ${String(MAX_LINKS)}. Each becomes its own run with the settings below.`}
              {...(visible.links === undefined ? {} : { error: visible.links })}
            >
              <Textarea
                id="repurpose-links"
                rows={6}
                // Links, not prose: no autocorrect, no capitalised first letter.
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="bg-sunken font-mono text-xs"
                placeholder={"https://www.youtube.com/watch?v=…\nhttps://youtu.be/…"}
                value={value.links}
                data-testid="source-links"
                aria-invalid={visible.links !== undefined}
                aria-describedby={
                  visible.links === undefined ? "repurpose-links-hint" : "repurpose-links-error"
                }
                onChange={(event) => {
                  set("links", event.target.value);
                }}
              />
            </Field>
            {lines.length === 0 ? null : (
              <div className="space-y-1" data-testid="links-summary">
                <p className="text-xs text-fg-1">
                  {linksToSend(lines).length === 1
                    ? "1 video"
                    : `${String(linksToSend(lines).length)} videos`}
                </p>
                {/* Every line that will not be sent, and why: fixed here, not after a round trip. */}
                <ul className="space-y-0.5 text-xs text-fg-2">
                  {lines
                    .filter((line) => line.problem !== null || line.duplicateOf !== null)
                    .map((line) => (
                      <li key={line.line} data-testid={`links-line-${String(line.line)}`}>
                        <span className="font-mono">Line {String(line.line)}:</span>{" "}
                        {line.problem ?? `the same video as line ${String(line.duplicateOf)}.`}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {rights}
          </div>
        ) : (
          <div
            role="tabpanel"
            id="repurpose-panel-upload"
            aria-labelledby="repurpose-tab-upload"
            className="space-y-3"
          >
            <Field
              label={allowSeveralFiles ? "Video files" : "Video file"}
              htmlFor="repurpose-file"
              {...(allowSeveralFiles
                ? { hint: `Choose one, or up to ${String(MAX_FILES)}: each becomes its own run.` }
                : {})}
              {...(visible.file === undefined ? {} : { error: visible.file })}
            >
              <input
                id="repurpose-file"
                type="file"
                accept="video/*"
                multiple={allowSeveralFiles}
                data-testid="source-file"
                aria-describedby={visible.file === undefined ? undefined : "repurpose-file-error"}
                className={cn(
                  "max-w-full text-sm text-fg-1",
                  "file:mr-3 file:h-9 file:cursor-pointer file:rounded-sm file:border file:border-border",
                  "file:bg-transparent file:px-4 file:text-sm file:font-medium file:text-fg-0",
                  "hover:file:bg-neutral-100/7",
                )}
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? []);
                  onChange({
                    ...value,
                    file: picked[0] ?? null,
                    files: allowSeveralFiles ? picked : [],
                  });
                }}
              />
            </Field>
            {files.length === 1 && (
              <p className="text-xs text-fg-1" data-testid="selected-file">
                {files[0]?.name}
              </p>
            )}
            {files.length > 1 && (
              <ul className="space-y-0.5 text-xs text-fg-1" data-testid="selected-files">
                {files.map((file, index) => (
                  <li key={`${file.name}-${String(index)}`} className="truncate">
                    {file.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* One setup panel, whichever tab is open (§3.3). */}
      <RunSetupFields value={value} onChange={onChange} problems={visible} brandKit={brandKit} />

      {serverError !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p role="alert" className="m-0 text-sm text-rejected" data-testid="start-server-error">
            {serverError}
          </p>
          {existingRunId === null ? null : (
            <Button variant="secondary" size="sm" asChild>
              <NextLink
                href={`/repurpose/${existingRunId}`}
                className="no-underline"
                data-testid="start-existing-run"
              >
                Open the existing run
              </NextLink>
            </Button>
          )}
          {/* Out of credits: submitting again only fails the same way, so the
              balance is the way on (not Billing's checkout, which is off). */}
          {seeCredits ? (
            <Button variant="secondary" size="sm" asChild>
              <NextLink href="/billing" className="no-underline" data-testid="start-see-credits">
                See your credits
              </NextLink>
            </Button>
          ) : null}
        </div>
      )}

      <Button type="submit" variant="primary" disabled={submitting} data-testid="start-run">
        {submitting ? "Starting…" : (submitLabel ?? "Start finding clips")}
      </Button>
    </form>
  );
}

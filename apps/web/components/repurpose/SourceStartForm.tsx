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
 */
import { ChevronRight } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { Button, Field, Input, cn } from "@montaj/ui";

import { PICKABLE_STYLES } from "@/components/editor/panels/system-styles";
import { LanguagePicker } from "@/components/projects/language-picker";
import { WritingScriptPicker } from "@/components/projects/writing-script-picker";
import { AUTOPILOT_COPY, DETAIL_COPY } from "@/components/repurpose/copy";
import { SOURCE_CEILING_MS, formatBytes, spanPhrase } from "@/components/repurpose/failure-detail";
import { formatClock, parseClock } from "@/components/repurpose/moment-time";
import { isPlausibleLink, normaliseSourceLink } from "@/components/repurpose/source-link";

/**
 * The spoken language when the person leaves it to us: the API detects it
 * from the video (the transcript's own language decides what follows).
 */
export const DETECT_LANGUAGE = "auto";

export interface StartFormValue {
  readonly tab: "link" | "upload";
  readonly url: string;
  /**
   * Where a long video's window starts, as typed (`m:ss` or `h:mm:ss`); empty
   * leaves it to the server (the most-replayed part, else the start). Links
   * only: an upload is processed whole, within the plan's upload limit.
   */
  readonly startAt: string;
  readonly file: File | null;
  /** A language tag, {@link DETECT_LANGUAGE}, or `undefined` while one is still to be picked. */
  readonly sourceLanguage: string | undefined;
  readonly outputLanguage: string;
  readonly scriptMode: string;
  readonly styleId: string;
  readonly method: "ai" | "manual";
  readonly requestedCandidates: number;
  readonly rightsAttested: boolean;
  /**
   * Autopilot: every moment becomes a clip and passing failures are retried,
   * with nobody at the page (`setup.automation: "auto"`). Off, the person
   * picks which moments become clips.
   */
  readonly autopilot: boolean;
}

/** The presets offered up front: every pickable style (`PICKABLE_STYLE_IDS`). */
export const RECOMMENDED_STYLES: readonly (typeof PICKABLE_STYLES)[number][] = PICKABLE_STYLES;

/**
 * The style a run starts with.
 *
 * Resolved from the catalogue at module load rather than hard-coded, because a
 * literal id here rots silently the day the style is renamed. It is committed to
 * form STATE, not computed at render: a chip that looks selected while the form
 * holds `""` is how every default submit ends up rejected by the API.
 */
export const DEFAULT_STYLE_ID: string = RECOMMENDED_STYLES[0]?.id ?? "";

export const EMPTY_START_FORM: StartFormValue = Object.freeze({
  tab: "link",
  url: "",
  startAt: "",
  file: null,
  sourceLanguage: DETECT_LANGUAGE,
  outputLanguage: "same",
  scriptMode: "auto",
  styleId: DEFAULT_STYLE_ID,
  method: "ai",
  requestedCandidates: 5,
  rightsAttested: false,
  autopilot: true,
});

/**
 * Caption output choices (§3.3).
 *
 * `hi-Latn` is its own entry, never folded into English: Roman-script Hinglish is
 * a different output from a translation, and conflating them is the single
 * mistake that would cost this product its differentiation (§10.4).
 */
const OUTPUT_LANGUAGES = [
  { key: "same", label: "Same as spoken" },
  { key: "en", label: "English" },
  { key: "hi", label: "Hindi (Devanagari)" },
  { key: "hi-Latn", label: "Hinglish (Roman)" },
] as const;

/** Scripts only matter when the output language has more than one in use. */
const SCRIPT_CHOICE_LANGUAGES = new Set(["same", "hi", "hi-Latn"]);

export interface StartFormProblems {
  readonly url?: string;
  readonly startAt?: string;
  readonly file?: string;
  readonly sourceLanguage?: string;
  readonly rights?: string;
  readonly style?: string;
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
  } else if (value.file === null) {
    problems.file = "Choose a video from your device.";
  } else if (cap !== undefined && Number.isFinite(cap) && cap > 0 && value.file.size > cap) {
    problems.file = `This file is larger than your plan allows (up to ${formatBytes(cap)}). Choose a smaller copy.`;
  }

  if (value.sourceLanguage === undefined) {
    // Never silently transcribe in a language nobody chose: it is the one
    // choice that changes what everything downstream costs and says (§3.3).
    // "Detect automatically" is a choice; "I'll choose it" with nothing picked
    // is not.
    problems.sourceLanguage = "Choose the language spoken in the video.";
  }

  // The API requires a non-empty style id. Checking it here means a refactor that
  // breaks the default can never again produce a silent 400 on the happy path.
  if (value.styleId.trim() === "") problems.style = "Choose a caption look.";

  return problems;
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
  readonly className?: string;
}

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
  className,
}: SourceStartFormProps): React.JSX.Element {
  const [showProblems, setShowProblems] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  // The last language picked by hand, so "I'll choose it" after a detour to
  // "Detect automatically" comes back to it rather than to nothing.
  const lastPicked = React.useRef<string | undefined>(
    value.sourceLanguage === DETECT_LANGUAGE ? undefined : value.sourceLanguage,
  );
  const startAtRef = React.useRef<HTMLInputElement>(null);
  // A start is not checked where it is not offered: a hidden field's error
  // would block the form with nothing to correct.
  const problems = validateStartForm(processesWholeVideos ? { ...value, startAt: "" } : value, {
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    ...(knownLength === undefined ? {} : { knownLength }),
  });
  const visible = showProblems ? problems : {};
  const detecting = value.sourceLanguage === DETECT_LANGUAGE;

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

  const TABS = ["link", "upload"] as const;
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  // Arrow keys move between the two tabs, as a tablist promises (roving focus).
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = TABS.indexOf(value.tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TABS.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    // eslint-disable-next-line security/detect-object-injection -- bounded index into a literal tuple
    const tab = TABS[next] ?? "link";
    set("tab", tab);
    // eslint-disable-next-line security/detect-object-injection -- key is one of two literals
    tabRefs.current[tab]?.focus();
  };

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
          Your video
        </h2>
        {/* Two equal tabs — neither is the "real" one (§3.3). Underline
            indicator per the Shirorekha tab recipe. */}
        <div
          role="tablist"
          aria-label="Where your video comes from"
          className="flex border-b border-border"
        >
          {TABS.map((tab) => {
            const selected = value.tab === tab;
            return (
              <button
                key={tab}
                ref={(node) => {
                  // eslint-disable-next-line security/detect-object-injection -- key is one of two literals
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
                  "-mb-px h-10 flex-1 border-b-2 px-4 text-sm font-medium transition-colors duration-[160ms]",
                  selected
                    ? "border-accent text-fg-0"
                    : "border-transparent text-fg-2 hover:text-fg-0",
                )}
              >
                {tab === "link" ? "Paste a link" : "Upload a video"}
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

            <div>
              {/* The whole row is the hit target, not just the 16 px box. */}
              <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-fg-1">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  checked={value.rightsAttested}
                  data-testid="rights-attested"
                  aria-invalid={visible.rights !== undefined}
                  aria-describedby={
                    visible.rights === undefined ? undefined : "repurpose-rights-error"
                  }
                  onChange={(event) => {
                    set("rightsAttested", event.target.checked);
                  }}
                />
                <span>I own this video or have permission to use it.</span>
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
          </div>
        ) : (
          <div
            role="tabpanel"
            id="repurpose-panel-upload"
            aria-labelledby="repurpose-tab-upload"
            className="space-y-3"
          >
            <Field
              label="Video file"
              htmlFor="repurpose-file"
              {...(visible.file === undefined ? {} : { error: visible.file })}
            >
              <input
                id="repurpose-file"
                type="file"
                accept="video/*"
                data-testid="source-file"
                aria-describedby={visible.file === undefined ? undefined : "repurpose-file-error"}
                className={cn(
                  "text-sm text-fg-1",
                  "file:mr-3 file:h-9 file:cursor-pointer file:rounded-sm file:border file:border-border",
                  "file:bg-transparent file:px-4 file:text-sm file:font-medium file:text-fg-0",
                  "hover:file:bg-neutral-100/7",
                )}
                onChange={(event) => {
                  set("file", event.target.files?.[0] ?? null);
                }}
              />
            </Field>
            {value.file !== null && (
              <p className="text-xs text-fg-1" data-testid="selected-file">
                {value.file.name}
              </p>
            )}
          </div>
        )}
      </section>

      {/* One setup panel, whichever tab is open (§3.3). */}
      <section
        className="space-y-5 rounded-md border border-border bg-surface p-5"
        aria-labelledby="repurpose-setup-heading"
      >
        <h2 id="repurpose-setup-heading" className="text-base text-fg-0">
          Captions and clips
        </h2>
        {/* A real radio group: detecting is a choice with its own name, not an
            empty picker. The picker (which owns its own button and its own
            `aria-label`, "Spoken language" — the group's visible name) appears
            only once the person says they will choose. */}
        <fieldset
          className="border-0 p-0"
          aria-describedby={
            visible.sourceLanguage === undefined ? undefined : "repurpose-language-error"
          }
        >
          <legend className="text-sm font-medium text-fg-1">Spoken language</legend>
          <div className="mt-1.5 flex flex-col">
            {(
              [
                { key: "detect", label: "Detect automatically" },
                { key: "choose", label: "I'll choose it" },
              ] as const
            ).map((option) => (
              <label
                key={option.key}
                className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-fg-1"
              >
                <input
                  type="radio"
                  name="spoken-language"
                  className="size-4 shrink-0 accent-accent"
                  value={option.key}
                  checked={option.key === "detect" ? detecting : !detecting}
                  data-testid={`language-${option.key}`}
                  onChange={() => {
                    set(
                      "sourceLanguage",
                      option.key === "detect" ? DETECT_LANGUAGE : lastPicked.current,
                    );
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
          {detecting ? (
            // Honest about the one case detection gets wrong most.
            <p className="mt-1 text-xs text-fg-2" data-testid="language-detect-hint">
              We work it out from the video. If it mixes languages, like Hindi and English, choosing
              it yourself is more reliable.
            </p>
          ) : (
            <div className="mt-1.5">
              <LanguagePicker
                value={value.sourceLanguage}
                fullWidth
                onChange={(tag) => {
                  lastPicked.current = tag;
                  set("sourceLanguage", tag);
                }}
              />
            </div>
          )}
          {visible.sourceLanguage !== undefined && (
            <p
              id="repurpose-language-error"
              role="alert"
              className="mt-1 text-xs text-rejected"
              data-testid="error-language"
            >
              {visible.sourceLanguage}
            </p>
          )}
        </fieldset>

        <Field label="Caption language" htmlFor="repurpose-output-language">
          <select
            id="repurpose-output-language"
            className="h-9 w-full rounded-sm border border-border bg-sunken px-3 text-sm text-fg-0 hover:border-neutral-600"
            value={value.outputLanguage}
            data-testid="output-language"
            onChange={(event) => {
              set("outputLanguage", event.target.value);
            }}
          >
            {OUTPUT_LANGUAGES.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Shown only when the choice means something (§3.3). The visible text is
            "Writing script" because that is what the picker announces itself as. */}
        {SCRIPT_CHOICE_LANGUAGES.has(value.outputLanguage) && (
          <div role="group" aria-labelledby="repurpose-script-label">
            <span id="repurpose-script-label" className="text-sm font-medium text-fg-1">
              Writing script
            </span>
            <div className="mt-1.5">
              <WritingScriptPicker
                value={value.scriptMode}
                fullWidth
                onChange={(key) => {
                  set("scriptMode", key);
                }}
              />
            </div>
          </div>
        )}

        <fieldset
          className="border-0 p-0"
          aria-describedby={visible.style === undefined ? undefined : "repurpose-style-error"}
        >
          <legend className="text-sm font-medium text-fg-1">Caption look</legend>
          <div className="mt-2 flex flex-wrap gap-2" data-testid="style-picker">
            {RECOMMENDED_STYLES.map((style, index) => {
              const selected = value.styleId === style.id;
              return (
                <button
                  key={style.id}
                  type="button"
                  data-testid={`style-${style.id}`}
                  aria-pressed={selected}
                  onClick={() => {
                    set("styleId", style.id);
                  }}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-sm border px-3 text-sm",
                    "transition-colors duration-[160ms]",
                    // Selected = the system's selection ring, not a tinted fill.
                    selected
                      ? "border-transparent bg-bg-2 text-fg-0 ring-1 ring-accent"
                      : "border-border text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
                  )}
                >
                  {style.name}
                  {index === 0 && <span className="text-2xs text-fg-2">Recommended</span>}
                </button>
              );
            })}
          </div>
          {visible.style !== undefined && (
            <p
              id="repurpose-style-error"
              role="alert"
              className="mt-1 text-xs text-rejected"
              data-testid="error-style"
            >
              {visible.style}
            </p>
          )}
        </fieldset>

        <fieldset className="border-0 p-0">
          <legend className="text-sm font-medium text-fg-1">How should the clips be chosen?</legend>
          <div className="mt-1.5 flex flex-col">
            {/* Equally visible, because manual is a first-class path, not a
                fallback for when the AI disappoints (§3.5). */}
            {(
              [
                { key: "ai", label: "Suggest the strongest moments for me" },
                { key: "manual", label: "I know the timestamps" },
              ] as const
            ).map((option) => (
              <label
                key={option.key}
                className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-fg-1"
              >
                <input
                  type="radio"
                  name="clip-method"
                  className="size-4 shrink-0 accent-accent"
                  value={option.key}
                  checked={value.method === option.key}
                  data-testid={`method-${option.key}`}
                  onChange={() => {
                    onChange({
                      ...value,
                      method: option.key,
                      requestedCandidates: option.key === "manual" ? 0 : 5,
                    });
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
          {value.method === "manual" && (
            // Says where the timestamps go, since this form has no field for them.
            <p className="mt-1 text-xs text-fg-2" data-testid="method-manual-hint">
              Once the transcript is ready, you add each moment by its start and end time on the
              next page.
            </p>
          )}
        </fieldset>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor="repurpose-autopilot" className="text-sm font-medium text-fg-1">
              {AUTOPILOT_COPY.label}
            </label>
            <p className="mt-1 text-xs text-fg-2" data-testid="autopilot-hint">
              {value.autopilot ? AUTOPILOT_COPY.on : AUTOPILOT_COPY.off}
            </p>
          </div>
          <input
            id="repurpose-autopilot"
            type="checkbox"
            role="switch"
            className="panel-switch mt-0.5 shrink-0"
            checked={value.autopilot}
            data-testid="autopilot-switch"
            onChange={(event) => {
              set("autopilot", event.target.checked);
            }}
          />
        </div>

        <div className="border-t border-border pt-4">
          <Button
            variant="ghost"
            size="sm"
            data-testid="advanced-toggle"
            aria-expanded={advancedOpen}
            aria-controls="repurpose-advanced"
            className="-ml-2"
            onClick={() => {
              setAdvancedOpen(!advancedOpen);
            }}
          >
            <ChevronRight
              aria-hidden="true"
              strokeWidth={1.75}
              className={cn("transition-transform duration-[160ms]", advancedOpen && "rotate-90")}
            />
            Advanced settings
          </Button>
          {advancedOpen && (
            <div className="mt-3" id="repurpose-advanced" data-testid="advanced-panel">
              <Field
                label="Number of suggested moments"
                htmlFor="repurpose-count"
                hint={
                  value.method === "manual"
                    ? "Not used when you pick the timestamps yourself."
                    : "Between 1 and 20."
                }
              >
                <Input
                  id="repurpose-count"
                  type="number"
                  min={1}
                  max={20}
                  className="w-32 bg-sunken"
                  disabled={value.method === "manual"}
                  value={value.requestedCandidates}
                  data-testid="requested-candidates"
                  aria-describedby="repurpose-count-hint"
                  onChange={(event) => {
                    set("requestedCandidates", Number(event.target.value));
                  }}
                />
              </Field>
            </div>
          )}
        </div>
      </section>

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
        {submitting ? "Starting…" : "Start finding clips"}
      </Button>
    </form>
  );
}

"use client";

/**
 * "Captions and clips" - the setup a run starts with (2026-10-02): spoken
 * language, caption language and script, caption look, how the moments are
 * chosen and what steers them, Autopilot, and the number of suggestions under
 * Advanced settings.
 *
 * Taken out of `SourceStartForm` unchanged - the same markup, ids, test ids
 * and words - so every place a run's setup is chosen asks the same questions
 * the same way: the start form (one link, several links, one or more files) and
 * the Automations page, whose saved setup is exactly the `setup` a start-form
 * run sends.
 *
 * `forChannel`: a channel's new videos are made into clips while nobody is at
 * the page, so "I know the timestamps" and the Autopilot switch are not
 * offered. The moments are always found for you, and Autopilot is always on;
 * the panel says so in a line instead of showing a switch that cannot move.
 *
 * The accessibility notes of `SourceStartForm` apply here unchanged: the
 * pickers sit in labelled groups, each chip or radio group is a real
 * `<fieldset><legend>`, and each error is attached to its control.
 */
import { ChevronRight } from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import type { CreateRepurposeRunRequest } from "@montaj/api-client";
import { Button, Field, Input, cn } from "@montaj/ui";

import type { BrollOffer } from "@/components/broll/use-broll-library";

import { PICKABLE_STYLES } from "@/components/editor/panels/system-styles";
import { LanguagePicker } from "@/components/projects/language-picker";
import { WritingScriptPicker } from "@/components/projects/writing-script-picker";
import { AUTOPILOT_COPY, BRAND_COPY, BROLL_COPY, STEERING_COPY } from "@/components/repurpose/copy";
import {
  CLIP_LENGTHS,
  DEFAULT_CLIP_LENGTH,
  TOPIC_MAX_LENGTH,
  discoverySteeringOf,
  lengthRange,
  skipMsOf,
  topicProblem,
  type ClipLength,
} from "@/components/repurpose/steering";
import { stylePreviewUrl } from "@/lib/style-previews";

/**
 * The spoken language when the person leaves it to us: the API detects it
 * from the video (the transcript's own language decides what follows).
 */
export const DETECT_LANGUAGE = "auto";

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

/** What the panel edits: a run's setup, as the form holds it. */
export interface RunSetupValue {
  /** A language tag, {@link DETECT_LANGUAGE}, or `undefined` while one is still to be picked. */
  readonly sourceLanguage: string | undefined;
  readonly outputLanguage: string;
  readonly scriptMode: string;
  readonly styleId: string;
  readonly method: "ai" | "manual";
  readonly requestedCandidates: number;
  /**
   * Autopilot: every moment becomes a clip and passing failures are retried,
   * with nobody at the page (`setup.automation: "auto"`). Off, the person
   * picks which moments become clips.
   */
  readonly autopilot: boolean;
  /**
   * The brand kit (2026-10-02): Autopilot puts the workspace's logo, colours
   * and end card on the clips (`setup.brand`). Offered only with Autopilot on
   * and a kit saved; on by default whenever it is offered.
   */
  readonly useBrand: boolean;
  /**
   * B-roll (2026-10-05): Autopilot cuts away to a picture where the speaker
   * names something (`setup.broll`). Offered only with Autopilot on and
   * something to fill a cutaway; `undefined` until the person moves the
   * switch, which reads as on with a library and off with stock photos only
   * ({@link brollOn}).
   */
  readonly useBroll?: boolean;
  /**
   * Steering (2026-09-29), for "Suggest the strongest moments for me" only:
   * what the clips should be about (empty is anything strong), how long they
   * should be, and the minutes of the start and end to take no clip from, as
   * typed (empty skips nothing).
   */
  readonly topic: string;
  readonly clipLength: ClipLength;
  readonly skipIntro: string;
  readonly skipOutro: string;
}

/** A fresh setup: detect the language, the first style, our moments, Autopilot on. */
export const EMPTY_RUN_SETUP: RunSetupValue = Object.freeze({
  sourceLanguage: DETECT_LANGUAGE,
  outputLanguage: "same",
  scriptMode: "auto",
  styleId: DEFAULT_STYLE_ID,
  method: "ai",
  requestedCandidates: 5,
  autopilot: true,
  useBrand: true,
  topic: "",
  clipLength: DEFAULT_CLIP_LENGTH,
  skipIntro: "",
  skipOutro: "",
});

export interface RunSetupProblems {
  readonly sourceLanguage?: string;
  readonly style?: string;
  readonly topic?: string;
  readonly skipIntro?: string;
  readonly skipOutro?: string;
}

/** Everything wrong with a setup right now, keyed by field. */
export function validateRunSetup(value: RunSetupValue): RunSetupProblems {
  const problems: { -readonly [K in keyof RunSetupProblems]: string } = {};
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
  // Steering is only offered, and only sent, when we pick the moments: a
  // hidden field's error would block the form with nothing to correct.
  if (value.method === "ai") {
    const topic = topicProblem(value.topic);
    if (topic !== undefined) problems.topic = topic;
    if (skipMsOf(value.skipIntro) === null) problems.skipIntro = STEERING_COPY.skipInvalid;
    if (skipMsOf(value.skipOutro) === null) problems.skipOutro = STEERING_COPY.skipInvalid;
  }
  return problems;
}

/** Whether B-roll is on: what the person chose, else on with a library and off with stock only. */
export function brollOn(value: RunSetupValue, offer: BrollOffer | undefined): boolean {
  if (offer === undefined) return false;
  return value.useBroll ?? offer === "library";
}

/**
 * The `setup` a run's request carries, from the panel (no window: a picked
 * start belongs to one link, and the start form adds it itself).
 * `forChannel` sends what a channel's runs always are: our moments, Autopilot.
 */
export function runSetupRequest(
  value: RunSetupValue,
  options: {
    readonly forChannel?: boolean;
    readonly brandKit?: boolean;
    readonly broll?: BrollOffer;
  } = {},
): CreateRepurposeRunRequest["setup"] {
  const method = options.forChannel === true ? "ai" : value.method;
  const autopilot = options.forChannel === true || value.autopilot;
  return {
    // The form never submits without a choice; `auto` is the safe reading
    // of a missing one, where "en" was a guess that cost money.
    sourceLanguage: value.sourceLanguage ?? DETECT_LANGUAGE,
    caption: {
      outputLanguage: value.outputLanguage,
      scriptMode: value.scriptMode as "auto" | "roman" | "native" | "bilingual",
      styleId: value.styleId,
    },
    discovery: {
      mode: method,
      requestedCandidates: method === "manual" ? 0 : value.requestedCandidates,
      // What the clips are about, how long, and what of the video to skip:
      // only when we pick the moments (steering, 2026-09-29).
      ...(method === "manual" ? {} : discoverySteeringOf(value)),
    },
    automation: autopilot ? "auto" : "manual",
    // Only what was offered and left on: Autopilot, a saved kit, the switch.
    ...(autopilot && options.brandKit === true && value.useBrand ? { brand: true } : {}),
    // B-roll likewise (2026-10-05): Autopilot, something to fill it, the switch.
    ...(autopilot && brollOn(value, options.broll) ? { broll: true } : {}),
  };
}

/** A skip in milliseconds as the form's minutes field holds it ("2", "1.5"); empty for none. */
function minutesText(ms: number | undefined): string {
  return ms === undefined || ms <= 0 ? "" : String(Math.round((ms / 60_000) * 100) / 100);
}

/**
 * A saved setup (a channel automation's) back into what the panel edits: the
 * inverse of {@link runSetupRequest}, with anything the saved setup does not
 * say read as the form's own default.
 */
export function runSetupValueOf(setup: CreateRepurposeRunRequest["setup"]): RunSetupValue {
  const discovery = setup.discovery;
  const manual = discovery.mode === "manual";
  return {
    sourceLanguage: setup.sourceLanguage,
    outputLanguage: setup.caption.outputLanguage ?? EMPTY_RUN_SETUP.outputLanguage,
    scriptMode: setup.caption.scriptMode ?? EMPTY_RUN_SETUP.scriptMode,
    styleId: setup.caption.styleId,
    method: manual ? "manual" : "ai",
    requestedCandidates: discovery.requestedCandidates ?? EMPTY_RUN_SETUP.requestedCandidates,
    autopilot: setup.automation !== "manual",
    useBrand: setup.brand === true,
    useBroll: setup.broll === true,
    topic: discovery.topic ?? "",
    clipLength: discovery.clipLength ?? EMPTY_RUN_SETUP.clipLength,
    skipIntro: minutesText(discovery.skipIntroMs),
    skipOutro: minutesText(discovery.skipOutroMs),
  };
}

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

/** The two "skip" fields: the video's start and its end. */
const SKIP_FIELDS = [
  { key: "skipIntro", label: STEERING_COPY.skipFirst, testId: "steering-skip-intro" },
  { key: "skipOutro", label: STEERING_COPY.skipLast, testId: "steering-skip-outro" },
] as const;

/** "Short", "Medium", "Long". */
function lengthLabel(length: ClipLength): string {
  return length === "short"
    ? STEERING_COPY.length.short
    : length === "long"
      ? STEERING_COPY.length.long
      : STEERING_COPY.length.medium;
}

export interface RunSetupFieldsProps<V extends RunSetupValue> {
  readonly value: V;
  readonly onChange: (next: V) => void;
  /** The problems to show now (empty until the person tries to submit). */
  readonly problems: RunSetupProblems;
  /** A channel's runs: our moments, always Autopilot (see the module comment). */
  readonly forChannel?: boolean;
  /**
   * Prefix for element ids and radio group names. The start form keeps its
   * own (`repurpose`), so its ids, and the tests that find them, are unchanged.
   */
  readonly idPrefix?: string;
  /** The workspace has a saved brand kit (2026-10-02): the brand switch is offered. */
  readonly brandKit?: boolean;
  /** What could fill a B-roll cutaway here (2026-10-05); no switch without it. */
  readonly broll?: BrollOffer;
}

export function RunSetupFields<V extends RunSetupValue>({
  value,
  onChange,
  problems,
  forChannel = false,
  idPrefix = "repurpose",
  brandKit = false,
  broll,
}: RunSetupFieldsProps<V>): React.JSX.Element {
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  // The last language picked by hand, so "I'll choose it" after a detour to
  // "Detect automatically" comes back to it rather than to nothing.
  const lastPicked = React.useRef<string | undefined>(
    value.sourceLanguage === DETECT_LANGUAGE ? undefined : value.sourceLanguage,
  );
  const detecting = value.sourceLanguage === DETECT_LANGUAGE;
  const id = (name: string): string => `${idPrefix}-${name}`;
  // The start form's radio groups keep their names; another form gets its own.
  const group = (name: string): string => (idPrefix === "repurpose" ? name : `${idPrefix}-${name}`);
  const method = forChannel ? "ai" : value.method;

  const set = <K extends keyof RunSetupValue>(key: K, next: RunSetupValue[K]): void => {
    onChange({ ...value, [key]: next } as V);
  };

  return (
    <section
      className="space-y-5 rounded-md border border-border bg-surface p-5"
      aria-labelledby={id("setup-heading")}
    >
      <h2 id={id("setup-heading")} className="text-base text-fg-0">
        Captions and clips
      </h2>
      {/* A real radio group: detecting is a choice with its own name, not an
          empty picker. The picker (which owns its own button and its own
          `aria-label`, "Spoken language" — the group's visible name) appears
          only once the person says they will choose. */}
      <fieldset
        className="border-0 p-0"
        aria-describedby={problems.sourceLanguage === undefined ? undefined : id("language-error")}
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
                name={group("spoken-language")}
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
        {problems.sourceLanguage !== undefined && (
          <p
            id={id("language-error")}
            role="alert"
            className="mt-1 text-xs text-rejected"
            data-testid="error-language"
          >
            {problems.sourceLanguage}
          </p>
        )}
      </fieldset>

      <Field label="Caption language" htmlFor={id("output-language")}>
        <select
          id={id("output-language")}
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
        <div role="group" aria-labelledby={id("script-label")}>
          <span id={id("script-label")} className="text-sm font-medium text-fg-1">
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
        aria-describedby={problems.style === undefined ? undefined : id("style-error")}
      >
        <legend className="text-sm font-medium text-fg-1">Caption look</legend>
        {/* Cards with each look's own picture (2026-10-01, OpusClip's caption
            templates): the still the catalogue renders from the same preview
            the editor animates, so the card shows what the clips will get. */}
        <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="style-picker">
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
                  "flex min-w-0 flex-col overflow-hidden rounded-sm border text-left",
                  "transition-colors duration-[160ms]",
                  // Selected = the system's selection ring, not a tinted fill.
                  selected
                    ? "border-transparent bg-bg-2 ring-2 ring-accent"
                    : "border-border hover:border-neutral-600",
                )}
              >
                <img
                  src={stylePreviewUrl(`${style.id}.png`)}
                  alt=""
                  loading="lazy"
                  width={270}
                  height={480}
                  className="aspect-[9/16] h-auto w-full bg-bg-2 object-cover"
                  data-testid={`style-preview-${style.id}`}
                />
                <span className="flex min-w-0 flex-col px-2 py-1.5">
                  <span
                    className={cn(
                      "truncate text-xs font-medium",
                      selected ? "text-fg-0" : "text-fg-1",
                    )}
                  >
                    {style.name}
                  </span>
                  {index === 0 && <span className="text-2xs text-fg-2">Recommended</span>}
                </span>
              </button>
            );
          })}
        </div>
        {problems.style !== undefined && (
          <p
            id={id("style-error")}
            role="alert"
            className="mt-1 text-xs text-rejected"
            data-testid="error-style"
          >
            {problems.style}
          </p>
        )}
      </fieldset>

      {forChannel ? null : (
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
                  name={group("clip-method")}
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
      )}

      {/* Steering (2026-09-29): only when we pick the moments - with the
          timestamps known, there is nothing for these to steer. */}
      {method === "ai" && (
        <div className="space-y-5" data-testid="steering-fields">
          <Field
            label={STEERING_COPY.topicLabel}
            htmlFor={id("topic")}
            hint={STEERING_COPY.topicHint}
            {...(problems.topic === undefined ? {} : { error: problems.topic })}
          >
            <Input
              id={id("topic")}
              className="bg-sunken"
              placeholder={STEERING_COPY.topicPlaceholder}
              maxLength={TOPIC_MAX_LENGTH}
              value={value.topic}
              data-testid="steering-topic"
              aria-invalid={problems.topic !== undefined}
              aria-describedby={problems.topic === undefined ? id("topic-hint") : id("topic-error")}
              onChange={(event) => {
                set("topic", event.target.value);
              }}
            />
          </Field>

          <fieldset className="border-0 p-0">
            <legend className="text-sm font-medium text-fg-1">{STEERING_COPY.lengthLegend}</legend>
            <div className="mt-1.5 flex flex-wrap gap-x-5">
              {CLIP_LENGTHS.map((length) => (
                <label
                  key={length}
                  className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-fg-1"
                >
                  <input
                    type="radio"
                    name={group("clip-length")}
                    className="size-4 shrink-0 accent-accent"
                    value={length}
                    checked={value.clipLength === length}
                    data-testid={`clip-length-${length}`}
                    onChange={() => {
                      set("clipLength", length);
                    }}
                  />
                  {lengthLabel(length)}
                  <span className="text-fg-2">({lengthRange(length)})</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset
            className="border-0 p-0"
            aria-describedby={
              problems.skipIntro === undefined && problems.skipOutro === undefined
                ? id("skip-hint")
                : id("skip-error")
            }
          >
            <legend className="text-sm font-medium text-fg-1">{STEERING_COPY.skipLegend}</legend>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-2">
              {SKIP_FIELDS.map((field) => (
                // The whole phrase is the label: "Skip the first 2 min".
                <label key={field.key} className="flex items-center gap-2 text-sm text-fg-1">
                  {field.label}
                  <Input
                    // A number pad with a decimal point: minutes may be "1.5".
                    inputMode="decimal"
                    autoComplete="off"
                    className="w-16 bg-sunken"
                    placeholder="0"
                    value={field.key === "skipIntro" ? value.skipIntro : value.skipOutro}
                    data-testid={field.testId}
                    aria-invalid={
                      (field.key === "skipIntro" ? problems.skipIntro : problems.skipOutro) !==
                      undefined
                    }
                    onChange={(event) => {
                      set(field.key, event.target.value);
                    }}
                  />
                  {STEERING_COPY.minutes}
                </label>
              ))}
            </div>
            <p id={id("skip-hint")} className="mt-1 text-xs text-fg-2">
              {STEERING_COPY.skipHint}
            </p>
            {problems.skipIntro === undefined && problems.skipOutro === undefined ? null : (
              <p
                id={id("skip-error")}
                role="alert"
                className="mt-1 text-xs text-rejected"
                data-testid="error-skip"
              >
                {problems.skipIntro ?? problems.skipOutro}
              </p>
            )}
          </fieldset>
        </div>
      )}

      {forChannel ? (
        // Not a switch that cannot move: a channel's runs are always Autopilot.
        <p className="text-sm text-fg-1" data-testid="autopilot-always">
          <span className="font-medium">{AUTOPILOT_COPY.label}</span> is always on for a
          channel&apos;s videos: the strongest moments become clips by themselves.
        </p>
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label htmlFor={id("autopilot")} className="text-sm font-medium text-fg-1">
              {AUTOPILOT_COPY.label}
            </label>
            <p className="mt-1 text-xs text-fg-2" data-testid="autopilot-hint">
              {value.autopilot ? AUTOPILOT_COPY.on : AUTOPILOT_COPY.off}
            </p>
          </div>
          <input
            id={id("autopilot")}
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
      )}

      {brandKit && (forChannel || value.autopilot) ? (
        <div className="flex items-start justify-between gap-4" data-testid="brand-kit-option">
          <div className="min-w-0">
            <label htmlFor={id("brand")} className="text-sm font-medium text-fg-1">
              {BRAND_COPY.label}
            </label>
            <p className="mt-1 text-xs text-fg-2" data-testid="brand-hint">
              {value.useBrand ? BRAND_COPY.on : BRAND_COPY.off}{" "}
              <NextLink
                href="/settings/brand-kit"
                className="text-accent-300 rounded-sm underline underline-offset-4 hover:text-accent-200"
              >
                Edit
              </NextLink>
            </p>
          </div>
          <input
            id={id("brand")}
            type="checkbox"
            role="switch"
            className="panel-switch mt-0.5 shrink-0"
            checked={value.useBrand}
            data-testid="brand-switch"
            onChange={(event) => {
              set("useBrand", event.target.checked);
            }}
          />
        </div>
      ) : null}

      {broll !== undefined && (forChannel || value.autopilot) ? (
        <div className="flex items-start justify-between gap-4" data-testid="broll-option">
          <div className="min-w-0">
            <label htmlFor={id("broll")} className="text-sm font-medium text-fg-1">
              {BROLL_COPY.label}
            </label>
            <p className="mt-1 text-xs text-fg-2" data-testid="broll-hint">
              {brollOn(value, broll)
                ? broll === "library"
                  ? BROLL_COPY.library
                  : BROLL_COPY.stock
                : BROLL_COPY.off}{" "}
              <NextLink
                href="/settings/broll"
                className="text-accent-300 rounded-sm underline underline-offset-4 hover:text-accent-200"
              >
                {BROLL_COPY.link}
              </NextLink>
            </p>
          </div>
          <input
            id={id("broll")}
            type="checkbox"
            role="switch"
            className="panel-switch mt-0.5 shrink-0"
            checked={brollOn(value, broll)}
            data-testid="broll-switch"
            onChange={(event) => {
              set("useBroll", event.target.checked);
            }}
          />
        </div>
      ) : null}

      <div className="border-t border-border pt-4">
        <Button
          variant="ghost"
          size="sm"
          data-testid="advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls={id("advanced")}
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
          <div className="mt-3" id={id("advanced")} data-testid="advanced-panel">
            <Field
              label="Number of suggested moments"
              htmlFor={id("count")}
              hint={
                method === "manual"
                  ? "Not used when you pick the timestamps yourself."
                  : "Between 1 and 20."
              }
            >
              <Input
                id={id("count")}
                type="number"
                min={1}
                max={20}
                className="w-32 bg-sunken"
                disabled={method === "manual"}
                value={value.requestedCandidates}
                data-testid="requested-candidates"
                aria-describedby={id("count-hint")}
                onChange={(event) => {
                  set("requestedCandidates", Number(event.target.value));
                }}
              />
            </Field>
          </div>
        )}
      </div>
    </section>
  );
}

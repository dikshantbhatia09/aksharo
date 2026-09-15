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
 */
import * as React from "react";

import { Button, Field, Input, cn } from "@montaj/ui";

import { SYSTEM_STYLES } from "@/components/editor/panels/system-styles";
import { LanguagePicker } from "@/components/projects/language-picker";
import { WritingScriptPicker } from "@/components/projects/writing-script-picker";

export interface StartFormValue {
  readonly tab: "link" | "upload";
  readonly url: string;
  readonly file: File | null;
  readonly sourceLanguage: string | undefined;
  readonly outputLanguage: string;
  readonly scriptMode: string;
  readonly styleId: string;
  readonly method: "ai" | "manual";
  readonly requestedCandidates: number;
  readonly rightsAttested: boolean;
}

/** The presets offered up front. "See all styles" opens the full picker later. */
export const RECOMMENDED_STYLE_IDS = [
  "punch-pop",
  "bold-drop",
  "karaoke-fill",
  "caption-card",
] as const;

/** The recommended styles that actually exist in the catalogue, in that order. */
export const RECOMMENDED_STYLES = RECOMMENDED_STYLE_IDS.map((id) =>
  SYSTEM_STYLES.find((style) => style.id === id),
).filter((style) => style !== undefined);

/**
 * The style a run starts with.
 *
 * Resolved from the catalogue at module load rather than hard-coded, because a
 * literal id here rots silently the day the style is renamed. It is committed to
 * form STATE, not computed at render: a chip that looks selected while the form
 * holds `""` is how every default submit ends up rejected by the API.
 */
export const DEFAULT_STYLE_ID: string = RECOMMENDED_STYLES[0]?.id ?? SYSTEM_STYLES[0]?.id ?? "";

export const EMPTY_START_FORM: StartFormValue = Object.freeze({
  tab: "link",
  url: "",
  file: null,
  sourceLanguage: undefined,
  outputLanguage: "same",
  scriptMode: "auto",
  styleId: DEFAULT_STYLE_ID,
  method: "ai",
  requestedCandidates: 5,
  rightsAttested: false,
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
  readonly file?: string;
  readonly sourceLanguage?: string;
  readonly rights?: string;
  readonly style?: string;
}

/** Everything wrong with the form right now, keyed by field. */
export function validateStartForm(value: StartFormValue): StartFormProblems {
  const problems: { -readonly [K in keyof StartFormProblems]: string } = {};

  if (value.tab === "link") {
    const url = value.url.trim();
    if (url === "") problems.url = "Paste a link to your video.";
    else if (!url.startsWith("https://")) problems.url = "Links must start with https://";
    if (!value.rightsAttested) {
      problems.rights = "Please confirm you own this video or have permission to use it.";
    }
  } else if (value.file === null) {
    problems.file = "Choose a video from your device.";
  }

  if (value.sourceLanguage === undefined) {
    // Never silently transcribe in a guessed language: it is the one choice that
    // changes what everything downstream costs and says (§3.3).
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
  readonly className?: string;
}

export function SourceStartForm({
  value,
  onChange,
  onSubmit,
  submitting = false,
  serverError = null,
  className,
}: SourceStartFormProps): React.JSX.Element {
  const [showProblems, setShowProblems] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const problems = validateStartForm(value);
  const visible = showProblems ? problems : {};

  const set = <K extends keyof StartFormValue>(key: K, next: StartFormValue[K]): void => {
    onChange({ ...value, [key]: next });
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    onSubmit();
  };

  return (
    <form onSubmit={submit} data-testid="repurpose-start-form" className={cn("space-y-6", className)}>
      {/* Two equal tabs — neither is the "real" one (§3.3). */}
      <div role="tablist" aria-label="Where your video comes from" className="flex gap-2">
        {(["link", "upload"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={value.tab === tab}
            data-testid={`source-tab-${tab}`}
            onClick={() => {
              set("tab", tab);
            }}
            className={cn(
              "flex-1 rounded-md border px-3 py-2 text-sm",
              value.tab === tab
                ? "border-lime-500/45 bg-lime-500/12 text-fg-0"
                : "border-border bg-bg-1 text-fg-2",
            )}
          >
            {tab === "link" ? "Paste a link" : "Upload a video"}
          </button>
        ))}
      </div>

      {value.tab === "link" ? (
        <div role="tabpanel" aria-label="Paste a link" className="space-y-3">
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

          <div>
            <label className="flex items-start gap-2 text-xs text-fg-1">
              <input
                type="checkbox"
                checked={value.rightsAttested}
                data-testid="rights-attested"
                aria-describedby={visible.rights === undefined ? undefined : "repurpose-rights-error"}
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
        <div role="tabpanel" aria-label="Upload a video" className="space-y-3">
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

      {/* One setup panel, whichever tab is open (§3.3). */}
      <div className="space-y-4 rounded-md border border-border bg-bg-1 p-4">
        {/* The picker owns its own button and its own `aria-label`; a `<label for>`
            beside it would point at nothing, so this is a named group instead and
            the visible text is the picker's own accessible name. */}
        <div
          role="group"
          aria-labelledby="repurpose-language-label"
          aria-describedby={
            visible.sourceLanguage === undefined ? undefined : "repurpose-language-error"
          }
        >
          <span id="repurpose-language-label" className="text-sm text-fg-1">
            Spoken language
          </span>
          <div className="mt-1.5">
            <LanguagePicker
              value={value.sourceLanguage}
              fullWidth
              onChange={(tag) => {
                set("sourceLanguage", tag);
              }}
            />
          </div>
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
        </div>

        <Field label="Caption language" htmlFor="repurpose-output-language">
          <select
            id="repurpose-output-language"
            className="w-full rounded-md border border-border bg-bg-2 px-3 py-2 text-sm text-fg-0"
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
            <span id="repurpose-script-label" className="text-sm text-fg-1">
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
          <legend className="text-sm text-fg-1">Caption look</legend>
          <div className="mt-2 flex flex-wrap gap-2" data-testid="style-picker">
            {RECOMMENDED_STYLES.map((style, index) => (
              <button
                key={style.id}
                type="button"
                data-testid={`style-${style.id}`}
                aria-pressed={value.styleId === style.id}
                onClick={() => {
                  set("styleId", style.id);
                }}
                className={cn(
                  "rounded-md border px-3 py-2 text-xs",
                  value.styleId === style.id
                    ? "border-lime-500/45 bg-lime-500/12 text-fg-0"
                    : "border-border bg-bg-2 text-fg-1",
                )}
              >
                {style.name}
                {index === 0 && <span className="ml-1 text-2xs text-fg-2">Recommended</span>}
              </button>
            ))}
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
          <legend className="text-sm text-fg-1">How should we choose the clips?</legend>
          <div className="mt-2 space-y-2">
            {/* Equally visible, because manual is a first-class path, not a
                fallback for when the AI disappoints (§3.5). */}
            {(
              [
                { key: "ai", label: "Let AI suggest moments" },
                { key: "manual", label: "I know the timestamps" },
              ] as const
            ).map((option) => (
              <label key={option.key} className="flex items-center gap-2 text-sm text-fg-1">
                <input
                  type="radio"
                  name="clip-method"
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
        </fieldset>

        <div>
          <button
            type="button"
            data-testid="advanced-toggle"
            aria-expanded={advancedOpen}
            aria-controls="repurpose-advanced"
            className="text-xs text-fg-2 underline"
            onClick={() => {
              setAdvancedOpen(!advancedOpen);
            }}
          >
            Advanced settings
          </button>
          {advancedOpen && (
            <div className="mt-3" id="repurpose-advanced" data-testid="advanced-panel">
              <Field label="How many suggestions?" htmlFor="repurpose-count">
                <Input
                  id="repurpose-count"
                  type="number"
                  min={1}
                  max={20}
                  disabled={value.method === "manual"}
                  value={value.requestedCandidates}
                  data-testid="requested-candidates"
                  onChange={(event) => {
                    set("requestedCandidates", Number(event.target.value));
                  }}
                />
              </Field>
            </div>
          )}
        </div>
      </div>

      {serverError !== null && (
        <p role="alert" className="text-sm text-rejected" data-testid="start-server-error">
          {serverError}
        </p>
      )}

      <Button type="submit" disabled={submitting} data-testid="start-run">
        {submitting ? "Starting…" : "Start finding clips"}
      </Button>
    </form>
  );
}

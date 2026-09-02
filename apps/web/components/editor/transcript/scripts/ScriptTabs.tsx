"use client";

/**
 * The editor's script tabs (A22 brief item 4): Roman / Native / EN / +Add
 * translation…
 *
 * This component owns the tab bar and the two producers (`ai.transliterate`,
 * free; `ai.translate`, 0.5 credit / media minute / target) — it does **not**
 * own what gets displayed under each tab. That is the transcript editor's
 * (A15) and the caption preview's (A16/A17) job, neither of which has landed
 * on `main` yet; this component is built so either can drop it in unchanged,
 * driven entirely by `activeScript`/`onScriptChange` and the transcript's own
 * `GET .../transcript/scripts` state. See `apps/web/components/editor/
 * transcript/scripts/README.md` for the integration note this leaves behind.
 *
 * Rules from the brief, encoded here:
 * - A script tab for `roman`/`native` that is not yet available triggers
 *   transliteration on click, once — a second click while it is available
 *   does nothing (there is nothing to "regenerate": transliteration always
 *   recomputes from the words, and a user's own `textOverrides` edit already
 *   wins over it at read time, so there is no destructive click to guard).
 * - `translated` is different: regenerating it **replaces** whatever text a
 *   user may have typed into that override, so a click when one already
 *   exists opens {@link RegenerateTranslationDialog} first.
 */

import * as React from "react";

import {
  useTranscriptScripts,
  useTranslateTranscript,
  useTransliterateTranscript,
} from "@montaj/api-client";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@montaj/ui";

import { RegenerateTranslationDialog } from "./RegenerateTranslationDialog";

import { cn } from "@/lib/utils";

/** Languages offered under "+ Add translation…". Extend freely; this is not a contract. */
export const TRANSLATION_LANGUAGE_OPTIONS: readonly {
  readonly tag: string;
  readonly label: string;
}[] = [
  { tag: "en", label: "English" },
  { tag: "hi", label: "Hindi" },
  { tag: "ta", label: "Tamil" },
  { tag: "te", label: "Telugu" },
  { tag: "bn", label: "Bengali" },
  { tag: "mr", label: "Marathi" },
  { tag: "gu", label: "Gujarati" },
  { tag: "kn", label: "Kannada" },
  { tag: "ml", label: "Malayalam" },
  { tag: "pa", label: "Punjabi" },
];

export interface ScriptTabsProps {
  readonly projectId: string;
  /** The script currently shown in the caption preview and the word editor. */
  readonly activeScript: string;
  readonly onScriptChange: (script: string) => void;
  readonly className?: string;
}

export function ScriptTabs({
  projectId,
  activeScript,
  onScriptChange,
  className,
}: ScriptTabsProps): React.JSX.Element {
  const { data, isPending, error } = useTranscriptScripts(projectId);
  const transliterate = useTransliterateTranscript(projectId);
  const translate = useTranslateTranscript(projectId);
  const [pendingRegenerate, setPendingRegenerate] = React.useState<string | null>(null);
  const [addingTranslation, setAddingTranslation] = React.useState(false);

  const scripts = data?.scripts ?? [];
  const romanAvailable = scripts.find((row) => row.script === "roman")?.available ?? false;
  const nativeAvailable = scripts.find((row) => row.script === "native")?.available ?? false;
  const translated = scripts.find((row) => row.script === "translated");

  const requestScript = React.useCallback(
    (script: "roman" | "native") => {
      const available = script === "roman" ? romanAvailable : nativeAvailable;
      onScriptChange(script);
      if (!available && !transliterate.isPending) {
        transliterate.mutate({ script });
      }
    },
    [romanAvailable, nativeAvailable, onScriptChange, transliterate],
  );

  const requestTranslation = React.useCallback(
    (target: string) => {
      setAddingTranslation(false);
      onScriptChange("translated");
      translate.mutate({ targets: [target] });
    },
    [onScriptChange, translate],
  );

  const handleTranslatedClick = (): void => {
    if (translated?.available === true) {
      onScriptChange("translated");
      // Regenerating replaces a user's own edit to `textOverrides.translated`
      // (09 §4): confirm before running the same target again.
      setPendingRegenerate(translated.language ?? "en");
      return;
    }
    setAddingTranslation(true);
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Tabs value={activeScript} onValueChange={onScriptChange}>
        <TabsList>
          <TabsTrigger value="roman" onClick={() => requestScript("roman")}>
            Roman
            {!romanAvailable &&
            transliterate.isPending &&
            transliterate.variables?.script === "roman" ? (
              <span className="text-fg-3 ml-1 text-xs">…</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="native" onClick={() => requestScript("native")}>
            Native
            {!nativeAvailable &&
            transliterate.isPending &&
            transliterate.variables?.script === "native" ? (
              <span className="text-fg-3 ml-1 text-xs">…</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="translated" onClick={handleTranslatedClick} disabled={isPending}>
            {translated?.available === true
              ? `Translated (${translated.language?.toUpperCase() ?? "?"})`
              : "+ Add translation…"}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {error ? (
        <p role="alert" className="text-danger-500 text-xs">
          Could not load the transcript&apos;s scripts.
        </p>
      ) : null}
      {translate.isError ? (
        <p role="alert" className="text-danger-500 text-xs">
          {translationErrorMessage(translate.error)}
        </p>
      ) : null}

      {addingTranslation ? (
        <div className="border-border flex items-center gap-2 rounded-md border p-2">
          <label htmlFor="translation-target" className="text-fg-2 text-xs">
            Translate to
          </label>
          <select
            id="translation-target"
            className="border-border rounded-sm border bg-transparent px-2 py-1 text-sm"
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) requestTranslation(event.target.value);
            }}
          >
            <option value="" disabled>
              Choose a language…
            </option>
            {TRANSLATION_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.tag} value={option.tag}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAddingTranslation(false)}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="sr-only">
            Transliteration is free; translation is 0.5 credit / media minute / target.
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Transliteration is free. Translation is billed per target language.
        </TooltipContent>
      </Tooltip>

      <RegenerateTranslationDialog
        open={pendingRegenerate !== null}
        language={pendingRegenerate ?? ""}
        onOpenChange={(open) => {
          if (!open) setPendingRegenerate(null);
        }}
        onConfirm={() => {
          const language = pendingRegenerate;
          setPendingRegenerate(null);
          if (language !== null) requestTranslation(language);
        }}
      />
    </div>
  );
}

function translationErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "transcript/plan_required") {
      return "Your plan does not include this translation. Upgrade to continue.";
    }
  }
  return "Could not start the translation.";
}

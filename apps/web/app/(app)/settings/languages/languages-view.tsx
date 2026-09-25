"use client";

import { Check } from "lucide-react";
import * as React from "react";

import { LangChip, Button, Card, cn, toast } from "@montaj/ui";

import { SettingsSection } from "@/components/settings/section";

/**
 * Languages & defaults (08 §Settings).
 *
 * The choices here set what a new project assumes; the routing they drive lives
 * in the AI pipeline (A10) and the real persistence lands with A05. Until then
 * the preferences are kept in this browser, which is honest about what they do
 * today and needs no migration when the endpoint exists.
 */

const SPOKEN = [
  "hi-Latn",
  "hi",
  "en-IN",
  "en",
  "bn",
  "ta",
  "te",
  "mr",
  "kn",
  "ml",
  "gu",
  "pa",
] as const;

const ASPECTS = [
  { key: "9:16", label: "9:16 — Reels, Shorts, TikTok" },
  { key: "16:9", label: "16:9 — YouTube, landscape" },
  { key: "1:1", label: "1:1 — feed square" },
  { key: "4:5", label: "4:5 — feed portrait" },
] as const;

const STORAGE_KEY = "aksharo.defaults";

interface Defaults {
  languages: string[];
  aspect: string;
}

const EMPTY: Defaults = { languages: ["hi-Latn"], aspect: "9:16" };

function read(): Defaults {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Defaults>;
    return {
      languages: Array.isArray(parsed.languages)
        ? parsed.languages.filter((value) => typeof value === "string")
        : EMPTY.languages,
      aspect: typeof parsed.aspect === "string" ? parsed.aspect : EMPTY.aspect,
    };
  } catch {
    return EMPTY;
  }
}

export function LanguagesView(): React.JSX.Element {
  const [value, setValue] = React.useState<Defaults>(EMPTY);

  React.useEffect(() => {
    setValue(read());
  }, []);

  const save = (): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      toast.success("Defaults saved");
    } catch {
      toast.error("Could not save", { description: "This browser is blocking local storage." });
    }
  };

  return (
    <SettingsSection
      title="Languages & defaults"
      description="What we assume when you start a project. You can change any of it per project."
      testId="settings-languages"
    >
      <Card className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="text-fg-0 text-sm font-semibold">Languages you speak on camera</legend>
          <p className="text-fg-2 text-xs">
            Hinglish first: most of what we transcribe is Hindi written in Roman script.
          </p>
          <div className="flex flex-wrap gap-2">
            {SPOKEN.map((language) => {
              const active = value.languages.includes(language);
              return (
                <button
                  key={language}
                  type="button"
                  role="checkbox"
                  aria-checked={active}
                  data-testid={`language-${language}`}
                  onClick={() => {
                    setValue({
                      ...value,
                      languages: active
                        ? value.languages.filter((item) => item !== language)
                        : [...value.languages, language],
                    });
                  }}
                  // Selected = a check mark plus the accent ring (never colour
                  // alone), and unselected chips keep full contrast instead of
                  // fading to 70 % (HIG Accessibility > Vision).
                  className={cn(
                    "inline-flex min-h-8 items-center gap-1 rounded-full pr-1",
                    active ? "ring-accent ring-1" : "hover:bg-neutral-100/7",
                  )}
                >
                  <LangChip language={language} />
                  {active ? (
                    <Check aria-hidden="true" className="text-fg-0 size-3.5" strokeWidth={2} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-fg-0 mb-1 text-sm font-semibold">Default aspect ratio</legend>
          {ASPECTS.map((aspect) => (
            <label
              key={aspect.key}
              className="border-border hover:bg-neutral-100/5 has-[:checked]:ring-accent flex min-h-10 cursor-pointer items-center gap-2.5 rounded-sm border px-3 py-2 text-sm has-[:checked]:ring-1"
            >
              <input
                type="radio"
                name="aspect"
                className="accent-accent"
                checked={value.aspect === aspect.key}
                onChange={() => {
                  setValue({ ...value, aspect: aspect.key });
                }}
              />
              {aspect.label}
            </label>
          ))}
        </fieldset>

        <Button variant="primary" className="self-start" onClick={save} data-testid="save-defaults">
          Save defaults
        </Button>
      </Card>
    </SettingsSection>
  );
}

"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useClaimReferral, useSaveOnboarding } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Card, cn, Field, Input, ProgressBar, toast } from "@montaj/ui";

import { messageForError } from "@/lib/errors";

/**
 * Onboarding steps 1–3 (F-002, 08 §Onboarding).
 *
 * Step 0 — date of birth, jurisdiction and the two consent toggles — is asked
 * during sign-up, because D60 makes it part of creating an account rather than
 * something to collect afterwards. What is left is the three questions that set
 * defaults: what you make, the languages you speak on camera, and how you found
 * us.
 *
 * The answers persist into the user's free-form `onboarding` object through
 * `PATCH /me` (A05). A draft is also kept in this browser, so closing the tab
 * halfway through does not lose three answers; B17 turns the saved answers into
 * real defaults and attribution events.
 */

const MAKES = [
  { key: "reels", label: "Reels / Shorts", hint: "Vertical, fast, caption-led" },
  { key: "youtube", label: "YouTube", hint: "Long form with chapters" },
  { key: "podcast", label: "Podcast", hint: "Audio first, clips after" },
  { key: "client", label: "Client work", hint: "Deliverables and review links" },
  { key: "gaming", label: "Gaming", hint: "Highlights and montages" },
] as const;

const LANGUAGES = [
  { key: "hi-Latn", label: "Hinglish (Roman)" },
  { key: "hi", label: "हिन्दी" },
  { key: "en-IN", label: "English (India)" },
  { key: "en", label: "English" },
  { key: "bn", label: "বাংলা" },
  { key: "ta", label: "தமிழ்" },
  { key: "te", label: "తెలుగు" },
  { key: "mr", label: "मराठी" },
  { key: "kn", label: "ಕನ್ನಡ" },
  { key: "ml", label: "മലയാളം" },
  { key: "gu", label: "ગુજરાતી" },
  { key: "pa", label: "ਪੰਜਾਬੀ" },
] as const;

const SOURCES = [
  "A friend or colleague",
  "YouTube",
  "Instagram",
  "Search",
  "A creator I follow",
  "Somewhere else",
] as const;

const STEP_TITLES = ["What do you make?", "Languages you speak on camera", "How did you find us?"];

const DRAFT_KEY = "aksharo.onboarding";

interface Draft {
  makes: string[];
  languages: string[];
  source: string;
  referralCode: string;
}

const EMPTY_DRAFT: Draft = { makes: [], languages: [], source: "", referralCode: "" };

function readDraft(): Draft {
  if (typeof window === "undefined") return EMPTY_DRAFT;
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (raw === null) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return {
      makes: Array.isArray(parsed.makes) ? parsed.makes.filter((v) => typeof v === "string") : [],
      languages: Array.isArray(parsed.languages)
        ? parsed.languages.filter((v) => typeof v === "string")
        : [],
      source: typeof parsed.source === "string" ? parsed.source : "",
      referralCode: typeof parsed.referralCode === "string" ? parsed.referralCode : "",
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeDraft(draft: Draft): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage disabled. `finish` still saves the answers through `PATCH /me`.
  }
}

export function OnboardingFlow(): React.JSX.Element {
  const router = useRouter();
  const save = useSaveOnboarding();
  const claimReferral = useClaimReferral();
  const [step, setStep] = React.useState(0);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);

  // Read the draft after mount: `localStorage` does not exist on the server, and
  // reading it during render would make the two markups disagree.
  React.useEffect(() => {
    setDraft(readDraft());
  }, []);

  const update = (patch: Partial<Draft>): void => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      writeDraft(next);
      return next;
    });
  };

  const finish = (): void => {
    save.mutate(
      {
        makes: draft.makes,
        languages: draft.languages,
        ...(draft.source === "" ? {} : { source: draft.source }),
        ...(draft.referralCode === "" ? {} : { referralCode: draft.referralCode }),
      },
      {
        onSuccess: () => {
          // B07b: claim a referral code posted here — best-effort. A failed
          // claim (an affiliate code, a typo, an already-claimed workspace)
          // must never strand a new user on onboarding, so its result is
          // never awaited or surfaced.
          if (draft.referralCode !== "") {
            claimReferral.mutate({ code: draft.referralCode });
          }
          router.replace("/");
        },
        onError: (error) => {
          toast.error("We could not save that", { description: messageForError(error) });
        },
      },
    );
  };

  const canContinue =
    step === 0 ? draft.makes.length > 0 : step === 1 ? draft.languages.length > 0 : true;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" data-testid="onboarding">
      <div className="flex flex-col gap-2">
        <p className="text-fg-2 text-xs">Step {step + 1} of 3</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{STEP_TITLES[step]}</h1>
        <ProgressBar
          value={((step + 1) / 3) * 100}
          label={`Onboarding progress, step ${String(step + 1)} of 3`}
        />
      </div>

      <Card className="flex flex-col gap-5">
        {step === 0 ? (
          <ChoiceGrid
            name="makes"
            options={MAKES}
            selected={draft.makes}
            onToggle={(key) => {
              update({ makes: toggle(draft.makes, key) });
            }}
          />
        ) : null}

        {step === 1 ? (
          <>
            <p className="text-fg-2 text-sm">
              Pick every language you use. Hinglish is first because it is what most of {BRAND.name}{" "}
              gets asked for — you can change this per project later.
            </p>
            <ChoiceGrid
              name="languages"
              options={LANGUAGES}
              selected={draft.languages}
              onToggle={(key) => {
                update({ languages: toggle(draft.languages, key) });
              }}
            />
          </>
        ) : null}

        {step === 2 ? (
          <>
            <ChoiceGrid
              name="source"
              options={SOURCES.map((label) => ({ key: label, label }))}
              selected={draft.source === "" ? [] : [draft.source]}
              single
              onToggle={(key) => {
                update({ source: draft.source === key ? "" : key });
              }}
            />
            <Field
              label="Referral code (optional)"
              htmlFor="referral"
              hint="If someone gave you a code, it goes here."
            >
              <Input
                id="referral"
                value={draft.referralCode}
                autoCapitalize="characters"
                onChange={(event) => {
                  update({ referralCode: event.target.value.toUpperCase() });
                }}
              />
            </Field>
          </>
        ) : null}
      </Card>

      <div className="flex items-center gap-2">
        {step > 0 ? (
          <Button
            variant="ghost"
            onClick={() => {
              setStep(step - 1);
            }}
          >
            Back
          </Button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              router.replace("/");
            }}
            data-testid="onboarding-skip"
          >
            Skip for now
          </Button>
          <Button
            variant="primary"
            disabled={!canContinue || save.isPending}
            data-testid="onboarding-next"
            onClick={() => {
              if (step < 2) {
                setStep(step + 1);
                return;
              }
              finish();
            }}
          >
            {step < 2 ? "Continue" : save.isPending ? "Saving…" : "Finish"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function toggle(values: string[], key: string): string[] {
  return values.includes(key) ? values.filter((value) => value !== key) : [...values, key];
}

function ChoiceGrid({
  name,
  options,
  selected,
  onToggle,
  single = false,
}: {
  name: string;
  options: readonly { key: string; label: string; hint?: string }[];
  selected: readonly string[];
  onToggle: (key: string) => void;
  single?: boolean;
}): React.JSX.Element {
  return (
    <div
      role={single ? "radiogroup" : "group"}
      aria-label={name}
      className="grid gap-2 sm:grid-cols-2"
    >
      {options.map((option) => {
        const active = selected.includes(option.key);
        return (
          <button
            key={option.key}
            type="button"
            role={single ? "radio" : "checkbox"}
            aria-checked={active}
            data-testid={`choice-${option.key}`}
            onClick={() => {
              onToggle(option.key);
            }}
            className={cn(
              "flex items-start gap-2.5 rounded-sm border px-3 py-2.5 text-left text-sm",
              "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
              active
                ? "border-lime-500 bg-lime-500/10 text-fg-0"
                : "border-border text-fg-1 hover:border-fg-2/60",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                active ? "border-lime-500 bg-lime-500 text-on-accent" : "border-border",
              )}
            >
              {active ? <Check className="size-3" /> : null}
            </span>
            <span>
              {option.label}
              {option.hint === undefined ? null : (
                <span className="text-fg-2 block text-xs">{option.hint}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

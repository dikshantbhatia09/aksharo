"use client";

import {
  Briefcase,
  Check,
  Gamepad2,
  Mic,
  Smartphone,
  MonitorPlay,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  useAttachAffiliateAttribution,
  useClaimReferral,
  useCurrentUser,
  useSaveOnboarding,
} from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, cn, Field, Input, PageHeader, toast } from "@montaj/ui";

import { ALL_LANGUAGES } from "@/components/projects/languages";
import { SampleProjectButton } from "@/components/projects/project-grid";
import { messageForError } from "@/lib/errors";
import { useT } from "@/lib/i18n/locale-provider";
import { classifyOnboardingCode } from "@/lib/onboarding/code-classifier";

/**
 * Onboarding steps 1–4 (F-002, 08 §Onboarding).
 *
 * Step 0 — date of birth, jurisdiction and the two consent toggles — is asked
 * during sign-up, because D60 makes it part of creating an account rather than
 * something to collect afterwards. What is left is: what you make, the
 * languages you speak on camera, how you found us (plus a code field), and a
 * final "you're set" step (B17) that offers a sample project so a person can
 * see the editor before uploading anything of their own.
 *
 * The answers persist into the user's free-form `onboarding` object through
 * `PATCH /me` (A05). A draft is also kept in this browser, so closing the tab
 * halfway through does not lose the answers; B17 turns the saved answers into
 * real defaults (aspect, style, export preset, language routing hints) and
 * attribution events (`onboarding_completed`, recorded server-side the first
 * time `onboarding.completedAt` appears).
 */

/** What you make → the Home quick-pick row's starting aspect, style and export preset. */
const MAKE_DEFAULTS: Record<
  string,
  { aspect: "9:16" | "16:9" | "1:1" | "4:5"; styleId: string; exportPreset: string }
> = {
  reels: { aspect: "9:16", styleId: "punch-pop", exportPreset: "reels" },
  youtube: { aspect: "16:9", styleId: "subtitle-classic", exportPreset: "youtube" },
  podcast: { aspect: "1:1", styleId: "podcast-duo", exportPreset: "podcast-clip" },
  client: { aspect: "16:9", styleId: "minimal-lower-third", exportPreset: "client-review" },
  gaming: { aspect: "9:16", styleId: "neon-glow", exportPreset: "highlights" },
};

const MAKES = ["reels", "youtube", "podcast", "client", "gaming"] as const;

/** The canvas puts an icon on each "what do you make" row. Lucide, per `lib/nav.ts`. */
const MAKE_ICONS: Record<(typeof MAKES)[number], LucideIcon> = {
  reels: Smartphone,
  // Lucide dropped its brand marks; MonitorPlay is the generic long-form one.
  youtube: MonitorPlay,
  podcast: Mic,
  client: Briefcase,
  gaming: Gamepad2,
};

/**
 * K02: this used to be its own hand-kept copy of the language list — the
 * exact duplication `language-picker.tsx` warned about. Both screens now read
 * `./languages.ts`'s `ALL_LANGUAGES`, so adding a language (Nepali, Urdu,
 * Pushto) only ever means touching one file.
 */
const LANGUAGES = ALL_LANGUAGES;

const SOURCES = ["friend", "youtube", "instagram", "search", "creator", "other"] as const;

const DRAFT_KEY = "aksharo.onboarding";
const TOTAL_STEPS = 4;

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

/** The defaults `MAKE_DEFAULTS` implies for whichever "what you make" options got picked. */
function defaultsFor(makes: readonly string[]): {
  defaultAspect?: "9:16" | "16:9" | "1:1" | "4:5";
  defaultStyleId?: string;
  defaultExportPreset?: string;
} {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const first = makes.map((key) => MAKE_DEFAULTS[key]).find((entry) => entry !== undefined);
  if (first === undefined) return {};
  return {
    defaultAspect: first.aspect,
    defaultStyleId: first.styleId,
    defaultExportPreset: first.exportPreset,
  };
}

export function OnboardingFlow(): React.JSX.Element {
  const t = useT();
  const router = useRouter();
  const me = useCurrentUser();
  const save = useSaveOnboarding();
  const claimReferral = useClaimReferral();
  const attach = useAttachAffiliateAttribution();
  const [step, setStep] = React.useState(0);
  const [draft, setDraft] = React.useState<Draft>(EMPTY_DRAFT);
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [finished, setFinished] = React.useState(false);

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

  const saveAnswers = (): void => {
    setCodeError(null);
    const code = draft.referralCode.trim();
    const codeType = code === "" ? undefined : classifyOnboardingCode(code);
    if (code !== "" && codeType === "invalid") {
      setCodeError(t("onboarding.code.invalid"));
      return;
    }

    save.mutate(
      {
        makes: draft.makes,
        languages: draft.languages,
        ...(draft.source === "" ? {} : { source: draft.source }),
        ...(code === "" ? {} : { referralCode: code }),
        ...(codeType === undefined ? {} : { codeType }),
        ...defaultsFor(draft.makes),
      },
      {
        onSuccess: () => {
          if (codeType === "referral") {
            // B07b: best-effort — a failed claim (a typo, an already-claimed
            // workspace) must never strand a new user on onboarding.
            claimReferral.mutate({ code });
          } else if (codeType === "affiliate" && me.data !== undefined) {
            attach.mutate({
              referredWorkspaceId: me.data.workspace.id,
              referredUserId: me.data.id,
              code,
            });
          }
          setFinished(true);
          setStep(3);
        },
        onError: (error) => {
          toast.error(t("onboarding.saveError"), { description: messageForError(error) });
        },
      },
    );
  };

  const canContinue =
    step === 0 ? draft.makes.length > 0 : step === 1 ? draft.languages.length > 0 : true;

  const stepTitle =
    step === 0
      ? t("onboarding.step.makes.title")
      : step === 1
        ? t("onboarding.step.languages.title")
        : step === 2
          ? t("onboarding.step.source.title")
          : t("onboarding.step.finish.title");

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 pt-3" data-testid="onboarding">
      {/*
        Progress is four numbered steps, not a bar: four is a countable
        number. Done steps carry a check and the current one the accent ring
        (the "selected" treatment), so the state is shape as well as colour.
        The "N of 4" sentence is the accessible name.
      */}
      <div
        className="flex items-center gap-2"
        role="group"
        aria-label={t("onboarding.progressLabel", { step: step + 1, total: TOTAL_STEPS })}
      >
        {Array.from({ length: TOTAL_STEPS }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            data-state={index < step ? "done" : index === step ? "current" : "todo"}
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-2xs font-medium",
              index < step && "bg-bg-2 text-fg-0",
              index === step && "bg-bg-2 text-fg-0 ring-accent ring-1",
              index > step && "text-fg-2 border-border border",
            )}
          >
            {index < step ? <Check className="size-3.5" /> : index + 1}
          </span>
        ))}
        <span className="text-fg-2 ml-auto text-xs">Takes under a minute</span>
      </div>

      {/* The step's question is the page title: one PageHeader, one shirorekha. */}
      <PageHeader title={stepTitle} aria-live="polite" />

      <div className="border-border bg-surface flex flex-col gap-4 rounded-md border p-5">
        {step === 0 ? (
          <ChoiceGrid
            name="makes"
            options={MAKES.map((key) => ({
              key,
              label: t(`onboarding.make.${key}`),
              hint: t(`onboarding.make.${key}.hint`),
              // eslint-disable-next-line security/detect-object-injection -- `key` is one of the five MAKES literals
              icon: MAKE_ICONS[key],
            }))}
            selected={draft.makes}
            onToggle={(key) => {
              update({ makes: toggle(draft.makes, key) });
            }}
          />
        ) : null}

        {step === 1 ? (
          <>
            <p className="text-fg-2 text-sm">
              {t("onboarding.step.languages.hint", { brand: BRAND.name })}
            </p>
            <ChoiceGrid
              name="languages"
              variant="chip"
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
              variant="chip"
              options={SOURCES.map((key) => ({ key, label: t(`onboarding.source.${key}`) }))}
              selected={draft.source === "" ? [] : [draft.source]}
              single
              onToggle={(key) => {
                update({ source: draft.source === key ? "" : key });
              }}
            />
            <Field
              label={t("onboarding.code.label")}
              htmlFor="referral"
              hint={t("onboarding.code.hint")}
              {...(codeError === null ? {} : { error: codeError })}
            >
              <Input
                id="referral"
                value={draft.referralCode}
                autoCapitalize="characters"
                aria-invalid={codeError !== null}
                data-testid="onboarding-code"
                onChange={(event) => {
                  setCodeError(null);
                  update({ referralCode: event.target.value.toUpperCase() });
                }}
              />
            </Field>
          </>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-3">
            <p className="text-fg-1 m-0 text-sm">{t("onboarding.step.finish.body")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                data-testid="onboarding-done"
                onClick={() => {
                  router.replace("/");
                }}
              >
                Open the studio
              </Button>
              <SampleProjectButton variant="outline" />
            </div>
          </div>
        ) : null}

        {/*
          The canvas keeps the step controls inside the card, Back on the left
          and Continue pushed right. Skip sits with Back rather than beside
          Continue: they are both "not this", and putting an escape next to
          the primary is how people miss the primary.
        */}
        {step === 3 ? null : (
          <div className="flex items-center gap-2 pt-1">
            {step > 0 ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setStep(step - 1);
                }}
              >
                {t("onboarding.back")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => {
                router.replace("/");
              }}
              data-testid="onboarding-skip"
            >
              {t("onboarding.skip")}
            </Button>
            <Button
              variant="primary"
              className="ml-auto"
              disabled={!canContinue || save.isPending || finished}
              data-testid="onboarding-next"
              onClick={() => {
                if (step < 2) {
                  setStep(step + 1);
                  return;
                }
                saveAnswers();
              }}
            >
              {step < 2
                ? t("onboarding.continue")
                : save.isPending
                  ? t("onboarding.saving")
                  : t("onboarding.finish")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function toggle(values: string[], key: string): string[] {
  return values.includes(key) ? values.filter((value) => value !== key) : [...values, key];
}

/**
 * The two shapes the canvas uses for a set of answers.
 *
 * `"row"` is the first step: one full-width row per option, with its icon —
 * five long labels read better stacked than shoulder to shoulder. `"chip"` is
 * the language and source steps: small pills that wrap, because there are
 * nine to fifteen of them and each is one or two words.
 *
 * Both are `role="checkbox"`/`"radio"` with `aria-checked`, so neither depends
 * on colour to say what is selected.
 */
function ChoiceGrid({
  name,
  options,
  selected,
  onToggle,
  single = false,
  variant = "row",
}: {
  name: string;
  options: readonly { key: string; label: string; hint?: string; icon?: LucideIcon }[];
  selected: readonly string[];
  onToggle: (key: string) => void;
  single?: boolean;
  variant?: "row" | "chip";
}): React.JSX.Element {
  return (
    <div
      role={single ? "radiogroup" : "group"}
      aria-label={name}
      className={variant === "chip" ? "flex flex-wrap gap-1.5" : "flex flex-col gap-2"}
    >
      {options.map((option) => {
        const active = selected.includes(option.key);
        const Icon = option.icon;

        if (variant === "chip") {
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
                "inline-flex h-8 items-center gap-1.5 rounded-sm border px-3 text-xs",
                "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
                // Selected = the accent ring plus a check, so it is not
                // colour alone (DESIGN.md accessibility floor).
                active
                  ? "border-accent bg-bg-2 text-fg-0 ring-accent ring-1"
                  : "border-border text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
              )}
            >
              {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
              {option.label}
            </button>
          );
        }

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
              "flex min-h-11 items-center gap-3 rounded-md border px-3 py-3 text-left text-sm",
              "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
              active
                ? "border-accent bg-bg-2 text-fg-0 ring-accent ring-1"
                : "border-border text-fg-1 hover:bg-neutral-100/7 hover:text-fg-0",
            )}
          >
            {Icon === undefined ? (
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                  active ? "border-fg-0 bg-fg-0 text-bg-0" : "border-neutral-600",
                )}
              >
                {active ? <Check className="size-3" /> : null}
              </span>
            ) : (
              <Icon className="text-fg-2 size-5 shrink-0" aria-hidden="true" />
            )}
            <span className="flex-1">
              {option.label}
              {option.hint === undefined ? null : (
                <span className="text-fg-2 block text-xs">{option.hint}</span>
              )}
            </span>
            {Icon !== undefined && active ? (
              <Check className="text-fg-0 size-4 shrink-0" aria-hidden="true" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

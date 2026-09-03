"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  useAttachAffiliateAttribution,
  useClaimReferral,
  useCurrentUser,
  useSaveOnboarding,
} from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Card, cn, Field, Input, ProgressBar, toast } from "@montaj/ui";

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
  { key: "ml", label: "മലയాളం" },
  { key: "gu", label: "ગુજરાતી" },
  { key: "pa", label: "ਪੰਜਾਬੀ" },
] as const;

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
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6" data-testid="onboarding">
      <div className="flex flex-col gap-2">
        <p className="text-fg-2 text-xs">
          {t("onboarding.stepOf", { step: step + 1, total: TOTAL_STEPS })}
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{stepTitle}</h1>
        <ProgressBar
          value={((step + 1) / TOTAL_STEPS) * 100}
          label={t("onboarding.progressLabel", { step: step + 1, total: TOTAL_STEPS })}
        />
      </div>

      <Card className="flex flex-col gap-5">
        {step === 0 ? (
          <ChoiceGrid
            name="makes"
            options={MAKES.map((key) => ({
              key,
              label: t(`onboarding.make.${key}`),
              hint: t(`onboarding.make.${key}.hint`),
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
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <p className="text-fg-1 text-sm">{t("onboarding.step.finish.body")}</p>
            <SampleProjectButton />
          </div>
        ) : null}
      </Card>

      {step === 3 ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            data-testid="onboarding-done"
            onClick={() => {
              router.replace("/");
            }}
          >
            {t("onboarding.skip")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
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

          <div className="ml-auto flex items-center gap-2">
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
        </div>
      )}
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

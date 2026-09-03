"use client";

/**
 * The editor's three first-run coach marks (B17 brief §1): transcript
 * editing, the style picker and export. Shown once — gated on
 * `onboarding.coachMarksShownAt`, the same free-form onboarding object the
 * wizard writes into, so "shown" survives across devices via `PATCH /me`
 * rather than living only in this browser's storage.
 *
 * Deliberately simple: three sequential callouts positioned off
 * `getBoundingClientRect()` of the `data-coach-mark="transcript|style|export"`
 * containers `editor-client.tsx` marks, not a general-purpose tour library —
 * there are exactly three steps and they never change.
 */
import * as React from "react";

import { useCurrentUser, useUpdateMe } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import { useT } from "@/lib/i18n/locale-provider";

interface Step {
  readonly target: "transcript" | "style" | "export";
  readonly titleKey: string;
  readonly bodyKey: string;
}

const STEPS: readonly Step[] = [
  {
    target: "transcript",
    titleKey: "coachmark.transcript.title",
    bodyKey: "coachmark.transcript.body",
  },
  { target: "style", titleKey: "coachmark.style.title", bodyKey: "coachmark.style.body" },
  { target: "export", titleKey: "coachmark.export.title", bodyKey: "coachmark.export.body" },
];

export function FirstRunCoachMarks(): React.JSX.Element | null {
  const t = useT();
  const me = useCurrentUser();
  const updateMe = useUpdateMe();
  const [index, setIndex] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  const [rect, setRect] = React.useState<DOMRect | null>(null);

  const alreadyShown = me.data?.onboarding.coachMarksShownAt !== undefined;
  const active = !alreadyShown && !dismissed && me.data !== undefined;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const step = STEPS[index];

  React.useEffect(() => {
    if (!active || step === undefined) {
      setRect(null);
      return;
    }
    const el = document.querySelector(`[data-coach-mark="${step.target}"]`);
    setRect(el instanceof HTMLElement ? el.getBoundingClientRect() : null);
  }, [active, step]);

  const finish = React.useCallback(() => {
    setDismissed(true);
    if (me.data === undefined) return;
    const existing = me.data.onboarding as Record<string, boolean | number | string | string[]>;
    updateMe.mutate({
      onboarding: { ...existing, coachMarksShownAt: new Date().toISOString() },
    });
  }, [me.data, updateMe]);

  if (!active || step === undefined || rect === null) return null;

  const top = Math.min(rect.top + rect.height / 2, window.innerHeight - 160);
  const left = rect.left + rect.width / 2 < window.innerWidth / 2 ? rect.right + 12 : undefined;
  const right = left === undefined ? window.innerWidth - rect.left + 12 : undefined;

  return (
    <div
      role="dialog"
      aria-label={t(step.titleKey)}
      data-testid="coach-mark"
      data-coach-mark-step={step.target}
      className="border-border bg-bg-1 fixed z-50 w-72 rounded-md border p-3 shadow-lg"
      style={{
        top,
        ...(left === undefined ? {} : { left }),
        ...(right === undefined ? {} : { right }),
      }}
    >
      <p className="text-fg-0 text-sm font-semibold">{t(step.titleKey)}</p>
      <p className="text-fg-2 mt-1 text-xs">{t(step.bodyKey)}</p>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-fg-3 text-2xs">
          {index + 1} / {STEPS.length}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" data-testid="coach-mark-skip" onClick={finish}>
            {t("coachmark.skip")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="coach-mark-next"
            onClick={() => {
              if (index + 1 < STEPS.length) {
                setIndex(index + 1);
              } else {
                finish();
              }
            }}
          >
            {index + 1 < STEPS.length ? t("coachmark.next") : t("coachmark.done")}
          </Button>
        </div>
      </div>
    </div>
  );
}

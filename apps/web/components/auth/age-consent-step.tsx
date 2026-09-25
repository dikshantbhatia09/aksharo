"use client";

import Link from "next/link";
import * as React from "react";

import type { Jurisdiction } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Field, Input, Label, Switch } from "@montaj/ui";

import { AUTH_LINK_CLASS } from "@/components/auth/auth-card";
import { evaluateAge, JURISDICTION_LABEL, JURISDICTIONS } from "@/lib/privacy/age-gate";

/**
 * Onboarding **step 0** (08 §Onboarding, D60): date of birth, jurisdiction, and
 * the two consent toggles — both off.
 *
 * It is one component because it is asked in two places: at the end of the email
 * sign-up form, and on the OAuth callback when Google answers
 * `status=registration` (Google supplies no date of birth, and D60 requires one
 * before an account exists).
 *
 * Nothing here is pre-ticked and nothing is bundled: analytics and memory are
 * separate switches, because a single "I agree" checkbox is not consent.
 */

export interface AgeConsentValue {
  dateOfBirth: string;
  jurisdiction: Jurisdiction;
  analytics: boolean;
  memory: boolean;
}

export const EMPTY_AGE_CONSENT: AgeConsentValue = {
  dateOfBirth: "",
  jurisdiction: "IN",
  analytics: false,
  memory: false,
};

export function AgeConsentStep({
  value,
  onChange,
  onSubmit,
  onBlocked,
  submitLabel = "Create account",
  pending = false,
  error,
}: {
  value: AgeConsentValue;
  onChange: (value: AgeConsentValue) => void;
  onSubmit: () => void;
  /** Called with the jurisdiction when the declared age is below its floor. */
  onBlocked: (jurisdiction: Jurisdiction) => void;
  submitLabel?: string;
  pending?: boolean;
  error?: string;
}): React.JSX.Element {
  const [touched, setTouched] = React.useState(false);
  const decision = evaluateAge(value.dateOfBirth, value.jurisdiction);
  const dateError =
    touched && value.dateOfBirth !== "" && !decision.valid
      ? "Enter your date of birth as a real date."
      : undefined;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (!decision.valid) return;
    if (decision.blocked) {
      onBlocked(value.jurisdiction);
      return;
    }
    onSubmit();
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={submit}
      noValidate
      data-testid="age-consent-step"
    >
      <Field
        label="Date of birth"
        htmlFor="dateOfBirth"
        hint="We ask once, so we apply the right rules for where you are. We never show it to anyone."
        {...(dateError === undefined ? {} : { error: dateError })}
      >
        <Input
          id="dateOfBirth"
          name="dateOfBirth"
          type="date"
          required
          autoComplete="bday"
          max={new Date().toISOString().slice(0, 10)}
          value={value.dateOfBirth}
          invalid={dateError !== undefined}
          onChange={(event) => {
            onChange({ ...value, dateOfBirth: event.target.value });
          }}
          onBlur={() => {
            setTouched(true);
          }}
        />
      </Field>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-fg-1 mb-1.5 text-sm font-medium">Where do you live?</legend>
        <div className="flex flex-col gap-1">
          {JURISDICTIONS.map((jurisdiction) => (
            <label
              key={jurisdiction}
              className="border-border text-fg-0 hover:bg-neutral-100/5 has-[:checked]:border-accent has-[:checked]:ring-accent flex min-h-10 cursor-pointer items-center gap-2.5 rounded-sm border px-3 py-2 text-sm has-[:checked]:ring-1"
            >
              <input
                type="radio"
                name="jurisdiction"
                value={jurisdiction}
                className="accent-accent size-4 shrink-0"
                checked={value.jurisdiction === jurisdiction}
                onChange={() => {
                  onChange({ ...value, jurisdiction });
                }}
              />
              {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
              {JURISDICTION_LABEL[jurisdiction]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="border-border flex flex-col gap-4 rounded-sm border p-4">
        <legend className="text-fg-1 px-1 text-sm font-medium">
          Privacy choices (both optional)
        </legend>
        <ConsentToggle
          id="consent-analytics"
          label="Product analytics"
          description="Anonymous usage events so we can see which features actually help. Off by default."
          checked={value.analytics}
          onChange={(analytics) => {
            onChange({ ...value, analytics });
          }}
        />
        <ConsentToggle
          id="consent-memory"
          label="Remember my spellings and preferences"
          description={`We never train AI models on your footage. ${BRAND.name} remembers your spellings and preferences on your account — view, edit or clear them any time.`}
          checked={value.memory}
          onChange={(memory) => {
            onChange({ ...value, memory });
          }}
        />
      </fieldset>

      <p className="text-fg-2 text-xs">
        By continuing you accept our{" "}
        <Link href="/legal/terms" className={AUTH_LINK_CLASS}>
          terms
        </Link>{" "}
        and have read the{" "}
        <Link href="/legal/privacy" className={AUTH_LINK_CLASS}>
          privacy notice
        </Link>
        .
      </p>

      {error === undefined ? null : (
        <p className="text-rejected text-sm" role="alert">
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={pending}
        data-testid="age-consent-submit"
      >
        {pending ? "Creating your account…" : submitLabel}
      </Button>
    </form>
  );
}

export function ConsentToggle({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const describedBy = `${id}-description`;
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={describedBy}
        data-testid={id}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        <p id={describedBy} className="text-fg-2 text-xs">
          {description}
        </p>
      </div>
    </div>
  );
}

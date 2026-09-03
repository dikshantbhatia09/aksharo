"use client";

import * as React from "react";

import { isApiError } from "@montaj/api-client";
import { Button, Field, Input } from "@montaj/ui";

import type { GstinProblem } from "@/lib/billing/gst";
import type { WorkspaceBillingView } from "@/lib/billing/types";

import { GST_STATES, validateGstin } from "@/lib/billing/gst";
import { useSetTaxProfile } from "@/lib/billing/hooks";
import { messageForError } from "@/lib/errors";

/**
 * Checkout step 1 (08 §Checkout tax step): India needs a validated State and
 * accepts an optional GSTIN with a state auto-fill; everywhere else asks only
 * for the billing country. `PUT /workspaces/{id}/tax-profile` is the
 * authority — this component's own GSTIN/state checks
 * (`@/lib/billing/gst.ts`) exist only to fail fast, before the round trip.
 */

const COMMON_COUNTRIES: readonly { readonly code: string; readonly name: string }[] = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "SG", name: "Singapore" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "JP", name: "Japan" },
];

const SELECT_CLASSNAME =
  "bg-bg-1 border-border text-fg-0 hover:border-fg-2/60 h-9 w-full rounded-sm border px-3 text-sm " +
  "transition-colors duration-[160ms] ease-[var(--ease-out-soft)] disabled:cursor-not-allowed " +
  "disabled:text-fg-disabled aria-[invalid=true]:border-rejected";

export function TaxProfileStep({
  billing,
  isOwner,
  onConfirmed,
}: {
  readonly billing: WorkspaceBillingView | undefined;
  readonly isOwner: boolean;
  readonly onConfirmed: () => void;
}): React.JSX.Element {
  const setTaxProfile = useSetTaxProfile();

  // Pre-fill from whatever is already on file — A04's sign-up guess
  // (`IN`/`DE`/`US`) or a previous, still-unconfirmed edit — so confirming an
  // already-correct guess is one click, not a re-typed form. `billing` is only
  // ever undefined for the render this component's parent skips (see
  // `checkout-sheet.tsx`'s loading gate), so a lazy initializer reading it
  // once is safe.
  const [isIndia, setIsIndia] = React.useState(() => (billing?.billingCountry ?? "IN") === "IN");
  const [country, setCountry] = React.useState(() => {
    const known = billing?.billingCountry;
    return known !== undefined && known !== "IN" && COMMON_COUNTRIES.some((c) => c.code === known)
      ? known
      : "US";
  });
  const [customCountry, setCustomCountry] = React.useState("");
  const [stateCode, setStateCode] = React.useState(billing?.billingStateCode ?? "");
  const [gstin, setGstin] = React.useState(billing?.gstin ?? "");
  const [legalName, setLegalName] = React.useState(billing?.legalName ?? "");
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  const resolvedCountry = country === "OTHER" ? customCountry.trim().toUpperCase() : country;

  const gstinFeedback = React.useMemo(() => {
    if (gstin.trim() === "") return null;
    const result = validateGstin(gstin, stateCode || undefined);
    return result.ok ? null : result.problem;
  }, [gstin, stateCode]);

  // A GSTIN's own first two digits name a State — auto-fill it once the
  // number looks complete, exactly as the design spec asks for.
  React.useEffect(() => {
    if (gstin.trim().length !== 15) return;
    const result = validateGstin(gstin);
    if (result.ok && stateCode === "") setStateCode(result.stateCode);
  }, [gstin, stateCode]);

  if (!isOwner) {
    return (
      <div
        className="border-border bg-bg-2 flex flex-col gap-2 rounded-md border border-dashed p-4 text-sm"
        data-testid="tax-profile-owner-only"
      >
        <p className="text-fg-0 font-medium">Ask the workspace owner to confirm billing details</p>
        <p className="text-fg-2 text-xs">
          Only the owner can set the billing country and GST State — it fixes the place of supply on
          every invoice this workspace ever gets.
        </p>
      </div>
    );
  }

  const submit = (): void => {
    setFieldError(null);
    if (isIndia && stateCode === "") {
      setFieldError("State is required for an Indian billing address.");
      return;
    }
    if (!isIndia && resolvedCountry.length !== 2) {
      setFieldError("Enter a two-letter country code.");
      return;
    }
    if (gstin.trim() !== "") {
      const verdict = validateGstin(gstin, isIndia ? stateCode : undefined);
      if (!verdict.ok) {
        setFieldError("Check the GSTIN — it does not look right yet.");
        return;
      }
    }

    setTaxProfile.mutate(
      {
        billingCountry: isIndia ? "IN" : resolvedCountry,
        ...(isIndia && stateCode !== "" ? { billingStateCode: stateCode } : {}),
        ...(isIndia && gstin.trim() !== "" ? { gstin: gstin.trim() } : {}),
        ...(legalName.trim() !== "" ? { legalName: legalName.trim() } : {}),
      },
      {
        onSuccess: () => {
          onConfirmed();
        },
        onError: (error) => {
          if (isApiError(error) && error.code === "workspace/tax_profile_invalid") {
            const problem = (error.details as { problem?: string } | undefined)?.problem;
            setFieldError(
              problem === undefined
                ? messageForError(error)
                : // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
                  (TAX_PROBLEM_MESSAGE[problem] ?? messageForError(error)),
            );
            return;
          }
          setFieldError(messageForError(error));
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="tax-profile-step">
      <div role="radiogroup" aria-label="Billing country" className="flex gap-2">
        <Button
          type="button"
          variant={isIndia ? "primary" : "outline"}
          size="sm"
          role="radio"
          aria-checked={isIndia}
          data-testid="tax-profile-india"
          onClick={() => {
            setIsIndia(true);
          }}
        >
          India
        </Button>
        <Button
          type="button"
          variant={!isIndia ? "primary" : "outline"}
          size="sm"
          role="radio"
          aria-checked={!isIndia}
          data-testid="tax-profile-outside-india"
          onClick={() => {
            setIsIndia(false);
          }}
        >
          Outside India
        </Button>
      </div>

      {isIndia ? (
        <>
          <Field
            label="State"
            htmlFor="tax-state"
            hint="Fixes the place of supply on every invoice."
          >
            <select
              id="tax-state"
              data-testid="tax-state-select"
              className={SELECT_CLASSNAME}
              value={stateCode}
              aria-invalid={fieldError !== null && stateCode === ""}
              onChange={(event) => {
                setStateCode(event.target.value);
              }}
            >
              <option value="">Select a State</option>
              {GST_STATES.map((state) => (
                <option key={state.code} value={state.code}>
                  {state.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="GSTIN (optional)"
            htmlFor="tax-gstin"
            hint="Auto-fills the State above once it's complete."
            error={
              gstinFeedback === null
                ? undefined
                : // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
                  (GSTIN_PROBLEM_TEXT[gstinFeedback] ?? "That GSTIN does not look right.")
            }
          >
            <Input
              id="tax-gstin"
              value={gstin}
              autoCapitalize="characters"
              invalid={gstinFeedback !== null}
              onChange={(event) => {
                setGstin(event.target.value.toUpperCase());
              }}
              placeholder="27AAPFU0939F1ZV"
            />
          </Field>
        </>
      ) : (
        <Field label="Country" htmlFor="tax-country">
          <select
            id="tax-country"
            data-testid="tax-country-select"
            className={SELECT_CLASSNAME}
            value={country}
            onChange={(event) => {
              setCountry(event.target.value);
            }}
          >
            {COMMON_COUNTRIES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
            <option value="OTHER">Other…</option>
          </select>
          {country === "OTHER" ? (
            <Input
              className="mt-2"
              value={customCountry}
              maxLength={2}
              placeholder="Two-letter country code, e.g. NZ"
              aria-label="Country code"
              onChange={(event) => {
                setCustomCountry(event.target.value.toUpperCase());
              }}
            />
          ) : null}
        </Field>
      )}

      <Field label="Legal name (optional)" htmlFor="tax-legal-name" hint="Printed on GST invoices.">
        <Input
          id="tax-legal-name"
          value={legalName}
          onChange={(event) => {
            setLegalName(event.target.value);
          }}
        />
      </Field>

      {fieldError === null ? null : (
        <p className="text-rejected text-sm" role="alert" data-testid="tax-profile-error">
          {fieldError}
        </p>
      )}

      <Button
        variant="primary"
        data-testid="tax-profile-submit"
        disabled={setTaxProfile.isPending}
        onClick={submit}
      >
        {setTaxProfile.isPending ? "Saving…" : "Continue"}
      </Button>
    </div>
  );
}

const GSTIN_PROBLEM_TEXT: Record<GstinProblem, string> = {
  malformed: "A GSTIN is 15 characters.",
  checksum_mismatch: "That check digit does not match — one character is wrong.",
  unknown_state_code: "That State code is not in use.",
  state_mismatch: "This GSTIN's State does not match the State selected above.",
};

const TAX_PROBLEM_MESSAGE: Record<string, string> = {
  country_invalid: "Choose a country.",
  state_required: "State is required for an Indian billing address.",
  state_invalid: "That is not a GST State.",
  state_not_applicable: "State only applies to an Indian billing address.",
  gstin_not_applicable: "A GSTIN only applies to an Indian billing address.",
  gstin_malformed: GSTIN_PROBLEM_TEXT.malformed,
  gstin_checksum_mismatch: GSTIN_PROBLEM_TEXT.checksum_mismatch,
  gstin_unknown_state: GSTIN_PROBLEM_TEXT.unknown_state_code,
  gstin_state_mismatch: GSTIN_PROBLEM_TEXT.state_mismatch,
};

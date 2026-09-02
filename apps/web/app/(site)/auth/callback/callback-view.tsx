"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { hasErrorCode, useCompleteOAuth } from "@montaj/api-client";
import type { Jurisdiction, TokenResponse } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import type { AgeConsentValue } from "@/components/auth/age-consent-step";

import { AgeConsentStep, EMPTY_AGE_CONSENT } from "@/components/auth/age-consent-step";
import { AuthCard } from "@/components/auth/auth-card";
import { BlockedMinor } from "@/components/auth/blocked-minor";
import { messageForError } from "@/lib/errors";
import { evaluateAge } from "@/lib/privacy/age-gate";
import { writePrivacy } from "@/lib/privacy/consent";
import { persistSession } from "@/lib/session/client";

/**
 * Where Google sends the browser back (`/auth/callback?code=…&status=…`).
 *
 * Two outcomes:
 *   `status=login`        an existing identity — exchange the handoff code and go.
 *   `status=registration` a new one — Google supplies no date of birth, and D60
 *                         requires one, so onboarding step 0 is asked *here*
 *                         before the account exists.
 *
 * The handoff code is single-use and short-lived, and tokens never travel in a
 * redirect URL — only this code does (A04).
 */
export function OAuthCallbackView(): React.JSX.Element {
  const params = useSearchParams();
  const router = useRouter();

  const code = params.get("code") ?? "";
  const status = params.get("status");
  const failureReason = params.get("reason");

  const [ageConsent, setAgeConsent] = React.useState<AgeConsentValue>(EMPTY_AGE_CONSENT);
  const [blockedIn, setBlockedIn] = React.useState<Jurisdiction | null>(null);

  const onTokens = React.useCallback(async (tokens: TokenResponse) => {
    await persistSession(tokens);
  }, []);
  const complete = useCompleteOAuth(onTokens);
  const { mutate } = complete;
  const started = React.useRef(false);

  const isRegistration = status === "registration";

  React.useEffect(() => {
    if (isRegistration || started.current || code === "") return;
    started.current = true;
    mutate(
      { code },
      {
        onSuccess: () => {
          router.replace("/");
        },
      },
    );
  }, [code, isRegistration, mutate, router]);

  if (params.get("status") === "error" || (code === "" && !isRegistration)) {
    return (
      <AuthCard title="Google sign-in did not finish">
        <p className="text-fg-2 text-sm" data-testid="oauth-error">
          {failureReason === "provider_error"
            ? "Google turned the request down. Try again, or use your email address."
            : "That sign-in link is incomplete. Start again from the sign-in page."}
        </p>
        <Button variant="secondary" asChild>
          <Link href="/login">Back to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  if (blockedIn !== null) {
    return (
      <AuthCard title="We cannot open an account yet">
        <BlockedMinor jurisdiction={blockedIn} />
      </AuthCard>
    );
  }

  if (isRegistration) {
    return (
      <AuthCard
        title="Almost there"
        subtitle="Google does not tell us your date of birth, and we need it to apply the right rules."
      >
        <AgeConsentStep
          value={ageConsent}
          onChange={setAgeConsent}
          submitLabel="Finish signing up"
          pending={complete.isPending}
          onBlocked={setBlockedIn}
          onSubmit={() => {
            const decision = evaluateAge(ageConsent.dateOfBirth, ageConsent.jurisdiction);
            complete.mutate(
              {
                code,
                dateOfBirth: ageConsent.dateOfBirth,
                jurisdiction: ageConsent.jurisdiction,
                consents: { analytics: ageConsent.analytics, memory: ageConsent.memory },
              },
              {
                onSuccess: () => {
                  writePrivacy({
                    analytics: ageConsent.analytics,
                    memory: ageConsent.memory,
                    marketing: false,
                    minor: decision.minor,
                  });
                  router.replace("/onboarding");
                },
                onError: (error) => {
                  if (hasErrorCode(error, "auth/age_restricted")) {
                    setBlockedIn(ageConsent.jurisdiction);
                  }
                },
              },
            );
          }}
          {...(complete.isError && !hasErrorCode(complete.error, "auth/age_restricted")
            ? { error: messageForError(complete.error) }
            : {})}
        />
      </AuthCard>
    );
  }

  if (complete.isError) {
    return (
      <AuthCard title="That sign-in has expired">
        <p className="text-fg-2 text-sm" data-testid="oauth-error">
          {messageForError(complete.error)}
        </p>
        <Button variant="secondary" asChild>
          <Link href="/login">Back to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Signing you in">
      <p className="text-fg-2 text-sm">One moment.</p>
    </AuthCard>
  );
}

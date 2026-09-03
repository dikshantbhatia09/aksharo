"use client";

import Link from "next/link";
import * as React from "react";
import { z } from "zod";

import { hasErrorCode, useSignUp } from "@montaj/api-client";
import type { Jurisdiction } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Field, Input } from "@montaj/ui";

import type { AgeConsentValue } from "@/components/auth/age-consent-step";

import { AgeConsentStep, EMPTY_AGE_CONSENT } from "@/components/auth/age-consent-step";
import { AuthCard } from "@/components/auth/auth-card";
import { BlockedMinor } from "@/components/auth/blocked-minor";
import { AuthDivider, GoogleButton } from "@/components/auth/google-button";
import { useRuntimeConfig } from "@/components/providers";
import { messageForError } from "@/lib/errors";
import { evaluateAge } from "@/lib/privacy/age-gate";
import { writePrivacy } from "@/lib/privacy/consent";

/**
 * Sign-up in two steps: who you are, then step 0 of onboarding (age + consents).
 *
 * The split exists because D60 makes date of birth and jurisdiction part of
 * account creation, and asking for them in the same breath as a password makes
 * a form nobody finishes. One request goes to the API, carrying both halves.
 *
 * The reply is **always 202** (A04 README §Enumeration) — the same answer for a
 * new address and one that already has an account — so the success copy says
 * "check your inbox" and offers sign-in, and never "that email is taken".
 */

const credentialsSchema = z.object({
  name: z.string().trim().min(1, "Tell us what to call you.").max(120),
  email: z.string().trim().min(3).max(254).email("That does not look like an email address."),
  password: z
    .string()
    .min(12, "Use at least 12 characters — a phrase you can remember beats a short jumble.")
    .max(256),
});

type Credentials = z.infer<typeof credentialsSchema>;

type Stage = "credentials" | "age" | "blocked" | "sent";

export function SignUpForm(): React.JSX.Element {
  const config = useRuntimeConfig();
  const [stage, setStage] = React.useState<Stage>("credentials");
  const [credentials, setCredentials] = React.useState<Credentials>({
    name: "",
    email: "",
    password: "",
  });
  const [issues, setIssues] = React.useState<Partial<Record<keyof Credentials, string>>>({});
  const [ageConsent, setAgeConsent] = React.useState<AgeConsentValue>(EMPTY_AGE_CONSENT);
  const [blockedIn, setBlockedIn] = React.useState<Jurisdiction>("IN");

  const signUp = useSignUp();

  const submitCredentials = (event: React.FormEvent): void => {
    event.preventDefault();
    const parsed = credentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      const next: Partial<Record<keyof Credentials, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === "string") next[field as keyof Credentials] ??= issue.message;
      }
      setIssues(next);
      return;
    }
    setIssues({});
    setStage("age");
  };

  const submitAll = (): void => {
    const decision = evaluateAge(ageConsent.dateOfBirth, ageConsent.jurisdiction);
    signUp.mutate(
      {
        email: credentials.email,
        password: credentials.password,
        name: credentials.name,
        dateOfBirth: ageConsent.dateOfBirth,
        jurisdiction: ageConsent.jurisdiction,
        consents: { analytics: ageConsent.analytics, memory: ageConsent.memory },
      },
      {
        onSuccess: () => {
          // The mirror analytics reads. D60: a declared minor never gets
          // analytics, whatever the toggle said.
          writePrivacy({
            analytics: ageConsent.analytics,
            memory: ageConsent.memory,
            marketing: false,
            minor: decision.minor,
          });
          setStage("sent");
        },
        onError: (error) => {
          if (hasErrorCode(error, "auth/age_restricted")) {
            setBlockedIn(ageConsent.jurisdiction);
            setStage("blocked");
          }
        },
      },
    );
  };

  if (stage === "sent") {
    return (
      <AuthCard
        title={config.authDevAutoVerify ? "You can sign in now" : "Check your inbox"}
        subtitle={
          config.authDevAutoVerify ? (
            <>
              Development auto-verification is enabled for{" "}
              <strong className="text-fg-1">{credentials.email}</strong>. No confirmation click is
              needed in this local build.
            </>
          ) : (
            <>
              If <strong className="text-fg-1">{credentials.email}</strong> can have an account, a
              confirmation link is on its way. It works once and lasts 24 hours.
            </>
          )
        }
        footer={
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-lime-500 rounded-sm hover:underline">
              Sign in
            </Link>
          </>
        }
      >
        <div className="flex flex-col gap-3" data-testid="signup-sent">
          {config.authDevAutoVerify ? (
            <p className="text-fg-2 text-sm">Use the sign-in link below with your new password.</p>
          ) : (
            <p className="text-fg-2 text-sm">
              Nothing in your inbox after a minute? Check spam, then ask for a{" "}
              <Link href="/magic" className="text-lime-500 rounded-sm hover:underline">
                sign-in link
              </Link>{" "}
              instead — that works whether or not this address already had an account.
            </p>
          )}
        </div>
      </AuthCard>
    );
  }

  if (stage === "blocked") {
    return (
      <AuthCard title="We cannot open an account yet">
        <BlockedMinor jurisdiction={blockedIn} defaultEmail={credentials.email} />
      </AuthCard>
    );
  }

  if (stage === "age") {
    return (
      <AuthCard
        title="A couple of legal things"
        subtitle="Step 1 of 2 done. This part decides which rules apply to your account."
      >
        <AgeConsentStep
          value={ageConsent}
          onChange={setAgeConsent}
          onSubmit={submitAll}
          onBlocked={(jurisdiction) => {
            setBlockedIn(jurisdiction);
            setStage("blocked");
          }}
          pending={signUp.isPending}
          {...(signUp.isError && !hasErrorCode(signUp.error, "auth/age_restricted")
            ? { error: messageForError(signUp.error) }
            : {})}
        />
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            setStage("credentials");
          }}
        >
          Back
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={`Start with ${BRAND.name}`}
      subtitle="Captions, cuts and reframes for the video you already shot."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="text-lime-500 rounded-sm hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <GoogleButton label="Sign up with Google" />
      <AuthDivider />

      <form className="flex flex-col gap-4" onSubmit={submitCredentials} noValidate>
        <Field
          label="Name"
          htmlFor="name"
          {...(issues.name === undefined ? {} : { error: issues.name })}
        >
          <Input
            id="name"
            name="name"
            autoComplete="name"
            required
            value={credentials.name}
            invalid={issues.name !== undefined}
            onChange={(event) => {
              setCredentials({ ...credentials, name: event.target.value });
            }}
          />
        </Field>

        <Field
          label="Email"
          htmlFor="email"
          {...(issues.email === undefined ? {} : { error: issues.email })}
        >
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={credentials.email}
            invalid={issues.email !== undefined}
            onChange={(event) => {
              setCredentials({ ...credentials, email: event.target.value });
            }}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          hint="At least 12 characters. A phrase you can remember beats a short jumble."
          {...(issues.password === undefined ? {} : { error: issues.password })}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={credentials.password}
            invalid={issues.password !== undefined}
            onChange={(event) => {
              setCredentials({ ...credentials, password: event.target.value });
            }}
          />
        </Field>

        <Button type="submit" variant="secondary" size="lg" data-testid="signup-continue">
          Continue
        </Button>
      </form>
    </AuthCard>
  );
}

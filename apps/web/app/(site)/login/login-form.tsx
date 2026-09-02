"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { z } from "zod";

import { useLogin } from "@montaj/api-client";
import type { TokenResponse } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Field, Input } from "@montaj/ui";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthDivider, GoogleButton } from "@/components/auth/google-button";
import { messageForError, retryAfterSeconds } from "@/lib/errors";
import { persistSession } from "@/lib/session/client";

const schema = z.object({
  email: z.string().trim().min(3).max(254).email("That does not look like an email address."),
  password: z.string().min(1, "Enter your password.").max(256),
});

/**
 * Sign in.
 *
 * The API answers `auth/invalid_credentials` for an unknown address and a wrong
 * password alike (A04 README §Enumeration), so this screen never distinguishes
 * them either — the copy points at the sign-in link, which works in both cases.
 */
export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const expired = params.get("reason") === "expired";
  const justVerified = params.get("verified") === "1";

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [issues, setIssues] = React.useState<Record<string, string>>({});

  const onTokens = React.useCallback(async (tokens: TokenResponse) => {
    await persistSession(tokens);
  }, []);
  const login = useLogin(onTokens);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === "string") next[field] ??= issue.message;
      }
      setIssues(next);
      return;
    }
    setIssues({});
    login.mutate(parsed.data, {
      onSuccess: () => {
        router.replace(next);
        router.refresh();
      },
    });
  };

  const retryIn = retryAfterSeconds(login.error);

  return (
    <AuthCard
      title={`Sign in to ${BRAND.name}`}
      {...(justVerified
        ? { subtitle: "Email confirmed. Sign in to finish setting up your account." }
        : expired
          ? { subtitle: "Your session ended. Sign in again to carry on where you left off." }
          : {})}
      footer={
        <>
          New here?{" "}
          <Link href="/signup" className="text-lime-500 rounded-sm hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <GoogleButton />
      <AuthDivider />

      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field
          label="Email"
          htmlFor="email"
          {...(issues["email"] === undefined ? {} : { error: issues["email"] })}
        >
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            invalid={issues["email"] !== undefined}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          {...(issues["password"] === undefined ? {} : { error: issues["password"] })}
        >
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            invalid={issues["password"] !== undefined}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </Field>

        {login.isError ? (
          <p className="text-rejected text-sm" role="alert" data-testid="login-error">
            {messageForError(login.error)}
            {retryIn === undefined ? "" : ` Try again in about ${String(retryIn)} s.`}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="secondary"
          size="lg"
          disabled={login.isPending}
          data-testid="login-submit"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="text-fg-2 text-sm">
        Forgotten your password? Ask for a{" "}
        <Link href="/magic" className="text-lime-500 rounded-sm hover:underline">
          one-time sign-in link
        </Link>{" "}
        instead.
      </p>
    </AuthCard>
  );
}

/**
 * Only same-site paths are followed after sign-in.
 *
 * `?next=https://evil.example` would otherwise turn the login page into an open
 * redirect, which is the classic way to make a phishing link look genuine.
 */
export function safeNext(value: string | null): string {
  if (value === null || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

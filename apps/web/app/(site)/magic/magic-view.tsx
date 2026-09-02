"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { useConsumeMagicLink, useRequestMagicLink } from "@montaj/api-client";
import type { TokenResponse } from "@montaj/api-client";
import { Button, Field, Input } from "@montaj/ui";

import { AuthCard } from "@/components/auth/auth-card";
import { messageForError } from "@/lib/errors";
import { persistSession } from "@/lib/session/client";

/**
 * `/magic` does both halves of the magic-link flow.
 *
 * With `?token=` it consumes the link and signs in. Without one it asks for an
 * address and posts it. The request **always answers 202**, so the confirmation
 * copy is the same whether or not the address has an account (A04 README
 * §Enumeration) — this page must never leak the difference.
 */
export function MagicView(): React.JSX.Element {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  return token === "" ? <RequestLink /> : <ConsumeLink token={token} />;
}

function RequestLink(): React.JSX.Element {
  const [email, setEmail] = React.useState("");
  const request = useRequestMagicLink();

  if (request.isSuccess) {
    return (
      <AuthCard title="Check your inbox">
        <p className="text-fg-2 text-sm" data-testid="magic-sent">
          If <strong className="text-fg-1">{email}</strong> has an account, a sign-in link is on its
          way. It works once and lasts 15 minutes.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in with a link"
      subtitle="No password needed. We email you a link that works once."
      footer={
        <>
          Prefer a password?{" "}
          <Link href="/login" className="text-lime-500 rounded-sm hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate(email);
        }}
        noValidate
      >
        <Field
          label="Email"
          htmlFor="magic-email"
          {...(request.isError ? { error: messageForError(request.error) } : {})}
        >
          <Input
            id="magic-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            invalid={request.isError}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          disabled={request.isPending}
          data-testid="magic-submit"
        >
          {request.isPending ? "Sending…" : "Email me a link"}
        </Button>
      </form>
    </AuthCard>
  );
}

function ConsumeLink({ token }: { token: string }): React.JSX.Element {
  const router = useRouter();
  const onTokens = React.useCallback(async (tokens: TokenResponse) => {
    await persistSession(tokens);
  }, []);
  const consume = useConsumeMagicLink(onTokens);
  const { mutate } = consume;
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(token, {
      onSuccess: () => {
        // A hard-refresh pair with replace, matching login-form.tsx: the
        // session cookie just changed via a plain fetch Next.js router
        // caching never observes on its own, so a bare replace can still
        // resolve the signed-out marketing "/" this same client session
        // may have cached rather than the authenticated rewrite to /home.
        router.replace("/");
        router.refresh();
      },
    });
  }, [mutate, router, token]);

  if (consume.isError) {
    return (
      <AuthCard title="That link no longer works">
        <p className="text-fg-2 text-sm" data-testid="magic-error">
          {messageForError(consume.error)}
        </p>
        <Button variant="secondary" asChild>
          <Link href="/magic">Send me a new link</Link>
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

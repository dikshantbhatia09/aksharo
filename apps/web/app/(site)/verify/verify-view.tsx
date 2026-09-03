"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { useVerifyEmail } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import { AuthCard } from "@/components/auth/auth-card";
import { messageForError } from "@/lib/errors";

/**
 * The destination of the confirmation email.
 *
 * `POST /auth/verify-email` confirms the address and answers `{verified: true}`
 * — it does **not** sign anyone in. That is A04's design and it is the right
 * one: a confirmation link lives in a mailbox, and a link that also hands out a
 * session hands it to anyone who reaches that mailbox. So this screen confirms,
 * then sends the user to sign in and carry on with onboarding.
 *
 * The token is single-use and lasts 24 hours, so the exchange runs exactly once.
 */
export function VerifyView(): React.JSX.Element {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";

  const verify = useVerifyEmail();
  const { mutate } = verify;
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current || token === "") return;
    started.current = true;
    mutate(token, {
      onSuccess: () => {
        router.replace(`/login?verified=1&next=${encodeURIComponent("/onboarding")}`);
      },
    });
  }, [mutate, router, token]);

  // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
  if (token === "") {
    return (
      <AuthCard title="That link is incomplete">
        <p className="text-fg-2 text-sm" data-testid="verify-error">
          The confirmation link needs the token that came with it. Open the link from your email
          again, or ask for a new one.
        </p>
        <Button variant="secondary" asChild>
          <Link href="/magic">Send me a sign-in link</Link>
        </Button>
      </AuthCard>
    );
  }

  if (verify.isError) {
    return (
      <AuthCard title="That link has expired">
        <p className="text-fg-2 text-sm" data-testid="verify-error">
          {messageForError(verify.error)}
        </p>
        <Button variant="secondary" asChild>
          <Link href="/magic">Send me a new link</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Confirming your email">
      <p className="text-fg-2 text-sm" data-testid="verify-pending">
        One moment — we are checking the link.
      </p>
    </AuthCard>
  );
}

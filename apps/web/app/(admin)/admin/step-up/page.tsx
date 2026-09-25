"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { endpoints, isApiError, useApiClient } from "@montaj/api-client";
import { Button, Field, Input, PageHeader } from "@montaj/ui";

import { AdminError } from "@/components/admin/admin-ui";
import { storeAdminSession } from "@/lib/admin/admin-session";

/**
 * `POST /admin/auth/step-up` (CONTRACTS §5): a TOTP code, checked against
 * this account's `admin_totp` enrolment, exchanged for a 30-minute
 * `kind: "admin"` token. Enrolment (`POST .../totp/enroll` + `/verify`) is
 * a one-time setup a superadmin walks a new admin through out of band —
 * this screen assumes it already happened and only drives step-up itself,
 * to keep the UI (and the review surface) small.
 *
 * `AdminShell` provides the `<main>` landmark; this page is its content.
 */
export default function AdminStepUpPage(): React.JSX.Element {
  const client = useApiClient();
  const router = useRouter();
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await client.call(endpoints.adminAuth.stepUp, { body: { code } });
      storeAdminSession({
        accessToken: result.accessToken,
        adminRoles: result.adminRoles,
        expiresIn: result.expiresIn,
      });
      // The server-side routing gate (middleware.ts) needs its own signal —
      // sessionStorage is invisible to it. Best-effort: a failed POST here
      // just means the next `/admin/**` navigation 404s and the visitor
      // steps up again, never a security gap (AdminGuard is unaffected).
      await fetch("/api/admin-hint", { method: "POST" }).catch(() => undefined);
      router.push("/admin");
    } catch (err) {
      setError(isApiError(err) ? err.message : "Step-up failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[80dvh] w-full max-w-sm flex-col justify-center gap-6 px-4 sm:px-6">
      <PageHeader
        eyebrow="Admin console"
        title="Admin step-up"
        description="Enter the 6-digit code from your authenticator app. The admin session lasts 30 minutes."
      />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Authentication code" htmlFor="admin-stepup-code">
          <Input
            id="admin-stepup-code"
            data-testid="admin-stepup-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replaceAll(/\D/gu, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            className="h-11 text-center font-mono text-lg tracking-[0.3em]"
          />
        </Field>
        {error !== null && <AdminError data-testid="admin-stepup-error">{error}</AdminError>}
        <Button type="submit" variant="primary" size="lg" disabled={pending || code.length !== 6}>
          {pending ? "Verifying…" : "Step up"}
        </Button>
      </form>
    </div>
  );
}

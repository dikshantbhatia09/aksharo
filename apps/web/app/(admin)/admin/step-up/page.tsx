"use client";

import { useRouter } from "next/navigation";
import * as React from "react";

import { endpoints, isApiError, useApiClient } from "@montaj/api-client";

import { storeAdminSession } from "@/lib/admin/admin-session";

/**
 * `POST /admin/auth/step-up` (CONTRACTS §5): a TOTP code, checked against
 * this account's `admin_totp` enrolment, exchanged for a 30-minute
 * `kind: "admin"` token. Enrolment (`POST .../totp/enroll` + `/verify`) is
 * a one-time setup a superadmin walks a new admin through out of band —
 * this screen assumes it already happened and only drives step-up itself,
 * to keep the UI (and the review surface) small.
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
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold text-neutral-100">Admin step-up</h1>
      <p className="text-sm text-neutral-400">
        Enter the 6-digit code from your authenticator app.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          data-testid="admin-stepup-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replaceAll(/\D/gu, "").slice(0, 6))}
          inputMode="numeric"
          maxLength={6}
          placeholder="123456"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-center text-lg tracking-widest text-neutral-100"
        />
        {error !== null && (
          <p data-testid="admin-stepup-error" className="text-sm text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || code.length !== 6}
          className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {pending ? "Verifying…" : "Step up"}
        </button>
      </form>
    </main>
  );
}

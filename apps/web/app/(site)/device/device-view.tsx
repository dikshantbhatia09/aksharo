"use client";

import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import {
  useApiContext,
  useDecideDeviceApproval,
  useDeviceApproval,
  useSession,
} from "@montaj/api-client";
import type { PendingApproval } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Field, Input } from "@montaj/ui";

import { AuthCard } from "@/components/auth/auth-card";
import { messageForError } from "@/lib/errors";
import { refreshSession } from "@/lib/session/client";

/**
 * Device-code approval (THREAT-MODEL T3).
 *
 * The whole point of this screen is that the person approving can tell whether
 * the request is theirs, so it shows **everything the API knows** about who is
 * asking — host app, client, device facts, address, coarse location — and says
 * "unknown" where there is no data rather than guessing. Approving requires an
 * authenticated session (the middleware sends a signed-out visitor to sign in
 * first), and the code is redeemable once.
 *
 * The copy leads with "only continue if you started this", because a phishing
 * flow looks exactly like a real one until the user reads the details.
 */
export function DeviceApprovalView(): React.JSX.Element {
  const params = useSearchParams();
  const router = useRouter();
  const session = useSession();

  const [code, setCode] = React.useState(() => normaliseUserCode(params.get("user_code") ?? ""));
  const [submittedCode, setSubmittedCode] = React.useState<string | null>(() =>
    params.get("user_code") === null ? null : normaliseUserCode(params.get("user_code") ?? ""),
  );
  const [outcome, setOutcome] = React.useState<"approved" | "denied" | null>(null);

  // The screen is reached straight from a redirect, so the shell's own bootstrap
  // may not have run: turn the cookie into an access token before the query.
  const { session: store } = useApiContext();
  React.useEffect(() => {
    if (store.getAccessToken() !== null) return;
    void refreshSession().then((refreshed) => {
      if (refreshed === null) {
        router.replace(`/login?next=${encodeURIComponent("/device")}`);
        return;
      }
      store.set(refreshed.accessToken);
    });
  }, [router, store]);

  const approval = useDeviceApproval(session === null ? null : submittedCode);
  const decide = useDecideDeviceApproval();

  if (outcome !== null) {
    return (
      <AuthCard title={outcome === "approved" ? "Approved" : "Not approved"}>
        <p className="text-fg-2 text-sm" data-testid="device-outcome">
          {outcome === "approved"
            ? `You can go back to the app — it will be signed in within a few seconds.`
            : `Nothing was signed in. If you did not start this, nobody got access.`}
        </p>
      </AuthCard>
    );
  }

  if (submittedCode === null || approval.isError) {
    return (
      <AuthCard
        title="Connect a device"
        subtitle={`Type the code shown in the app or panel. It looks like 4F7K-92QA and lasts ten minutes.`}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmittedCode(normaliseUserCode(code));
          }}
          noValidate
        >
          <Field
            label="Device code"
            htmlFor="user-code"
            {...(approval.isError ? { error: messageForError(approval.error) } : {})}
          >
            <Input
              id="user-code"
              name="user_code"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              required
              className="font-mono tracking-[0.2em] uppercase"
              value={code}
              invalid={approval.isError}
              onChange={(event) => {
                setCode(event.target.value.toUpperCase());
              }}
            />
          </Field>
          <Button type="submit" variant="secondary" size="lg" data-testid="device-code-submit">
            Continue
          </Button>
        </form>
      </AuthCard>
    );
  }

  if (approval.isPending || approval.data == null) {
    return (
      <AuthCard title="Checking that code">
        <p className="text-fg-2 text-sm">One moment.</p>
      </AuthCard>
    );
  }

  const details = approval.data;

  return (
    <AuthCard
      title="Approve this sign-in?"
      subtitle={`Only continue if you just started this yourself. ${BRAND.name} will never ask you for a code over the phone.`}
    >
      <dl
        className="border-border divide-border divide-y rounded-sm border text-sm"
        data-testid="device-facts"
      >
        <Fact label="App" value={hostAppLabel(details)} />
        <Fact label="Device" value={deviceLabel(details)} />
        <Fact label="Operating system" value={stringFact(details.deviceInfo["os"])} />
        <Fact label="IP address" value={details.ip ?? "unknown"} />
        <Fact label="Approximate location" value={locationLabel(details)} />
        <Fact label="Code" value={details.userCode} mono />
      </dl>

      {decide.isError ? (
        <p className="text-rejected text-sm" role="alert">
          {messageForError(decide.error)}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          size="lg"
          className="flex-1"
          disabled={decide.isPending}
          data-testid="device-approve"
          onClick={() => {
            decide.mutate(
              { userCode: details.userCode, decision: "approve" },
              {
                onSuccess: () => {
                  setOutcome("approved");
                },
              },
            );
          }}
        >
          Yes, that is me
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="flex-1"
          disabled={decide.isPending}
          data-testid="device-deny"
          onClick={() => {
            decide.mutate(
              { userCode: details.userCode, decision: "deny" },
              {
                onSuccess: () => {
                  setOutcome("denied");
                },
              },
            );
          }}
        >
          No, I did not start this
        </Button>
      </div>
    </AuthCard>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-2">
      <dt className="text-fg-2 text-xs">{label}</dt>
      <dd className={mono ? "text-fg-0 font-mono text-sm tracking-widest" : "text-fg-0 text-sm"}>
        {value}
      </dd>
    </div>
  );
}

const HOST_APP_LABEL: Record<string, string> = {
  web: "Web",
  desktop: `${BRAND.name} desktop app`,
  premiere: "Adobe Premiere Pro",
  ae: "Adobe After Effects",
  resolve: "DaVinci Resolve",
};

export function hostAppLabel(approval: PendingApproval): string {
  if (approval.hostApp !== null) return HOST_APP_LABEL[approval.hostApp] ?? approval.hostApp;
  return HOST_APP_LABEL[approval.clientKind] ?? approval.clientKind;
}

export function deviceLabel(approval: PendingApproval): string {
  const name = stringFact(approval.deviceInfo["deviceName"] ?? approval.deviceInfo["hostname"]);
  return name === "unknown" ? approval.clientKind : name;
}

/** "unknown" rather than a guess: there is no geo-IP database (A04 open Q3). */
export function locationLabel(approval: PendingApproval): string {
  const parts = [approval.location?.city, approval.location?.region, approval.location?.country]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(", ");
  return parts === "" ? "unknown" : parts;
}

function stringFact(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "unknown";
}

/** Strip the readability dash: `4F7K-92QA` and `4f7k92qa` are the same code. */
export function normaliseUserCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  endpoints,
  useApiClient,
  useConsents,
  useCurrentUser,
  useSetConsents,
} from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import {
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Separator,
  toast,
} from "@montaj/ui";

import { ConsentToggle } from "@/components/auth/age-consent-step";
import { SettingsSection } from "@/components/settings/section";
import { resetAnalytics } from "@/lib/analytics/posthog";
import { messageForError } from "@/lib/errors";
import {
  DEFAULT_PRIVACY,
  readPrivacy,
  subscribePrivacy,
  writePrivacy,
} from "@/lib/privacy/consent";
import { clearSession } from "@/lib/session/client";

/**
 * Privacy: consents, data export, erasure (07 §Privacy & rights, D60, D62).
 *
 * Withdrawing a consent takes effect in this browser **immediately** — analytics
 * is opted out and reset before the request to the API is even in flight —
 * because "we will stop once the server confirms" is not what a person means
 * when they turn a switch off.
 */
export function PrivacyView(): React.JSX.Element {
  const router = useRouter();
  const client = useApiClient();
  const me = useCurrentUser();
  const consents = useConsents();
  const setConsents = useSetConsents();

  // The server render has no `localStorage`, so the first value is the safe
  // default; re-read after mount, and follow later changes from anywhere else in
  // the app.
  const [local, setLocal] = React.useState(DEFAULT_PRIVACY);
  React.useEffect(() => {
    setLocal(readPrivacy());
    return subscribePrivacy(setLocal);
  }, []);
  const [confirmation, setConfirmation] = React.useState("");
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // The server is the record; the local mirror is what analytics reads before
  // any authenticated request can happen. Reconcile whenever the server answers.
  React.useEffect(() => {
    if (consents.data === undefined || consents.data.length === 0) return;
    const next = {
      analytics: consents.data.find((row) => row.purpose === "analytics")?.granted ?? false,
      memory: consents.data.find((row) => row.purpose === "memory")?.granted ?? false,
      marketing: consents.data.find((row) => row.purpose === "marketing")?.granted ?? false,
    };
    setLocal(writePrivacy(next));
  }, [consents.data]);

  const isMinor = me.data?.ageBracket === "minor";

  const update = (patch: { analytics?: boolean; memory?: boolean; marketing?: boolean }): void => {
    const next = writePrivacy(patch);
    setLocal(next);
    if (patch.analytics === false) resetAnalytics();
    setConsents.mutate(
      { analytics: next.analytics, memory: next.memory, marketing: next.marketing },
      {
        onError: (error) => {
          toast.error("We could not record that", { description: messageForError(error) });
        },
      },
    );
  };

  const exportData = (): void => {
    void client
      .call(endpoints.pending.exportData)
      .then(() => {
        toast.success("Export started", {
          description: "We will email you a link when the bundle is ready.",
        });
      })
      .catch((error: unknown) => {
        toast.error("Could not start the export", { description: messageForError(error) });
      });
  };

  const deleteAccount = (): void => {
    setDeleting(true);
    void client
      .call(endpoints.pending.deleteAccount, { body: { confirmation } })
      .then(async () => {
        await clearSession();
        resetAnalytics();
        router.replace("/login?reason=deleted");
      })
      .catch((error: unknown) => {
        setDeleting(false);
        toast.error("Could not delete the account", { description: messageForError(error) });
      });
  };

  return (
    <SettingsSection
      title="Privacy"
      description="What we may collect, what we remember, and how to take it all back."
      testId="settings-privacy"
    >
      <Card className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-base font-medium">Consents</h2>

        {isMinor ? (
          <p className="border-border text-fg-2 rounded-sm border border-dashed p-3 text-xs">
            Your account is marked as under 18, so product analytics, streaks and referral rewards
            stay off. That is not a setting you can change here.
          </p>
        ) : null}

        <ConsentToggle
          id="settings-analytics"
          label="Product analytics"
          description="Anonymous usage events so we can see which features actually help."
          checked={local.analytics && !isMinor}
          disabled={isMinor}
          onChange={(analytics) => {
            update({ analytics });
          }}
        />

        <ConsentToggle
          id="settings-memory"
          label="Remember my spellings and preferences"
          description={`We never train AI models on your footage. ${BRAND.name} remembers your spellings and preferences on your account — view, edit or clear them any time.`}
          checked={local.memory}
          onChange={(memory) => {
            update({ memory });
          }}
        />

        <ConsentToggle
          id="settings-marketing"
          label="Product emails"
          description="Occasional notes about new features. Never more than monthly."
          checked={local.marketing && !isMinor}
          disabled={isMinor}
          onChange={(marketing) => {
            update({ marketing });
          }}
        />

        <p className="text-fg-2 text-xs">
          Read the{" "}
          <Link href="/legal/privacy" className="text-lime-500 rounded-sm hover:underline">
            privacy notice
          </Link>{" "}
          for what each of these covers.
        </p>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-base font-medium">Your data</h2>
        <p className="text-fg-2 text-sm">
          Export everything we hold: projects, transcripts, settings and what we learned. We build
          the bundle in the background and email you a link.
        </p>
        <Button
          variant="secondary"
          className="self-start"
          onClick={exportData}
          data-testid="export-data"
        >
          Export my data
        </Button>
      </Card>

      <Card className="border-rejected/40 flex flex-col gap-3">
        <h2 className="text-fg-0 text-base font-medium">Delete your account</h2>
        <p className="text-fg-2 text-sm">
          This erases your projects, media, transcripts and everything we learned, within 30 days.
          It cannot be undone, and an active subscription is cancelled rather than refunded.
        </p>
        <Separator />
        <Button
          variant="danger"
          className="self-start"
          data-testid="delete-account"
          onClick={() => {
            setDeleteOpen(true);
          }}
        >
          Delete account
        </Button>
      </Card>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              Everything goes: projects, media, transcripts, exports and what we learned. Type
              DELETE to confirm.
            </DialogDescription>
          </DialogHeader>

          <Field label="Type DELETE" htmlFor="delete-confirmation">
            <Input
              id="delete-confirmation"
              value={confirmation}
              autoComplete="off"
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
            />
          </Field>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDeleteOpen(false);
              }}
            >
              Keep my account
            </Button>
            <Button
              variant="danger"
              disabled={confirmation !== "DELETE" || deleting}
              data-testid="delete-account-confirm"
              onClick={deleteAccount}
            >
              {deleting ? "Deleting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

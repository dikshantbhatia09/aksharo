"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  useConsents,
  useCurrentUser,
  useDeleteAccount,
  useExportMyData,
  useSetConsent,
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
import { endSession } from "@/lib/session/client";

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
  const me = useCurrentUser();
  const consents = useConsents();
  const exportRequest = useExportMyData();
  const deleteRequest = useDeleteAccount();
  const setConsent = useSetConsent();

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
    const purposes = consents.data?.purposes;
    if (purposes === undefined) return;
    const granted = (purpose: string): boolean =>
      purposes.find((row) => row.purpose === purpose)?.granted ?? false;
    setLocal(
      writePrivacy({
        analytics: granted("analytics"),
        memory: granted("memory"),
        marketing: granted("marketing"),
        telemetry: granted("telemetry"),
      }),
    );
  }, [consents.data]);

  const isMinor = me.data?.ageBracket === "minor";

  /**
   * Record one decision.
   *
   * The browser's mirror is written first and analytics opted out immediately,
   * because "we will stop once the server confirms" is not what a person means
   * when they turn a switch off. The API takes one purpose per call: a consent
   * record is per purpose, and a refusal is a row too.
   */
  const update = (
    purpose: "analytics" | "memory" | "marketing" | "telemetry",
    granted: boolean,
  ): void => {
    setLocal(writePrivacy({ [purpose]: granted }));
    if (purpose === "analytics" && !granted) resetAnalytics();
    setConsent.mutate(
      { purpose, granted },
      {
        onError: (error) => {
          toast.error("We could not record that", { description: messageForError(error) });
        },
      },
    );
  };

  const exportData = (): void => {
    exportRequest.mutate(undefined, {
      onSuccess: (request) => {
        toast.success("Export started", {
          description: `We will email you a link by ${formatDueDate(request.dueAt)}.`,
        });
      },
      onError: (error) => {
        toast.error("Could not start the export", { description: messageForError(error) });
      },
    });
  };

  const deleteAccount = (): void => {
    setDeleting(true);
    deleteRequest.mutate(undefined, {
      onSuccess: () => {
        void (async () => {
          // Deleting the account revokes server-side, but this browser must not
          // keep a usable refresh token if any of that partially failed.
          await endSession();
          resetAnalytics();
          router.replace("/login?reason=deleted");
        })();
      },
      onError: (error) => {
        setDeleting(false);
        toast.error("Could not delete the account", { description: messageForError(error) });
      },
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
          onChange={(granted) => {
            update("analytics", granted);
          }}
        />

        <ConsentToggle
          id="settings-memory"
          label="Remember my spellings and preferences"
          description={`We never train AI models on your footage. ${BRAND.name} remembers your spellings and preferences on your account — view, edit or clear them any time.`}
          checked={local.memory}
          onChange={(granted) => {
            update("memory", granted);
          }}
        />

        <ConsentToggle
          id="settings-marketing"
          label="Product emails"
          description="Occasional notes about new features. Never more than monthly."
          checked={local.marketing && !isMinor}
          disabled={isMinor}
          onChange={(granted) => {
            update("marketing", granted);
          }}
        />

        <ConsentToggle
          id="settings-telemetry"
          label="Desktop and plugin telemetry"
          description="Crash reports and usage events from the desktop app, local bridge and editor plugins — never sent without this on, never to a third party directly from your device."
          checked={local.telemetry}
          onChange={(granted) => {
            update("telemetry", granted);
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
/** "by 2 October" — the statutory clock on a rights request, in words. */
function formatDueDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "the due date";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(date);
}

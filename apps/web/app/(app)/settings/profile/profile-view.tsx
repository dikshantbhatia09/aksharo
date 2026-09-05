"use client";

import Link from "next/link";
import * as React from "react";

import { useCurrentUser, useSession, useUpdateMe } from "@montaj/api-client";
import { Badge, Button, Card, Field, Input, Skeleton, toast } from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";
import { SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";

/** Profile: the name we call you, the address you sign in with, your role. */
export function ProfileView(): React.JSX.Element {
  const me = useCurrentUser();
  const session = useSession();
  const updateMe = useUpdateMe();
  const { googleOAuthEnabled } = useRuntimeConfig();
  const [name, setName] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (loaded || me.data == null) return;
    setName(me.data.name ?? "");
    setLoaded(true);
  }, [loaded, me.data]);

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    updateMe.mutate(
      { name: name.trim() === "" ? null : name.trim() },
      {
        onSuccess: () => {
          toast.success("Saved");
        },
        onError: (error) => {
          toast.error("Could not save that", { description: messageForError(error) });
        },
      },
    );
  };

  return (
    <SettingsSection
      title="Profile"
      description="Your name, the address you sign in with, and your role in this workspace."
      testId="settings-profile"
    >
      <Card className="flex flex-col gap-4">
        {me.isPending ? (
          <Skeleton className="h-24" />
        ) : (
          <form className="flex flex-col gap-4" onSubmit={save}>
            <Field
              label="Name"
              htmlFor="profile-name"
              hint="What we call you in the app and in emails."
            >
              <Input
                id="profile-name"
                value={name}
                autoComplete="name"
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>

            <Field
              label="Email"
              htmlFor="profile-email"
              hint="Changing the address you sign in with is not available yet."
            >
              <Input id="profile-email" value={me.data?.email ?? ""} readOnly disabled />
            </Field>

            <div className="flex items-center gap-2">
              <Button
                type="submit"
                variant="secondary"
                disabled={updateMe.isPending}
                data-testid="save-profile"
              >
                {updateMe.isPending ? "Saving…" : "Save"}
              </Button>
              {session === null ? null : <Badge tone="neutral">{session.role}</Badge>}
              {me.data?.emailVerified === false ? (
                <Badge tone="warning">Email not confirmed</Badge>
              ) : null}
            </div>
          </form>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-base font-medium">How you sign in</h2>
        <p className="text-fg-2 text-sm">
          {googleOAuthEnabled
            ? "Password, Google, or a one-time link"
            : "Password or a one-time link"}
          . Manage the devices that are signed in under{" "}
          <Link href="/settings/devices" className="text-lime-500 rounded-sm hover:underline">
            Devices &amp; sessions
          </Link>
          .
        </p>
      </Card>
    </SettingsSection>
  );
}

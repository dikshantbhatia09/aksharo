"use client";

import * as React from "react";

import { useJoinParentalWaitlist } from "@montaj/api-client";
import type { Jurisdiction } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Button, Field, Input } from "@montaj/ui";

import { messageForError } from "@/lib/errors";
import { MINIMUM_AGE } from "@/lib/privacy/age-gate";

/**
 * The friendly block of D60.
 *
 * India blocks under-18s and the EU under-16s until a verifiable
 * parental-consent flow (DigiLocker-class) ships. The screen says why, says who
 * it applies to, and offers the waiting list — it never explains how to get
 * around the check, and it never asks for a parent's details, because storing
 * those without a lawful basis would be the same mistake in a different place.
 */
export function BlockedMinor({
  jurisdiction,
  defaultEmail = "",
}: {
  jurisdiction: Jurisdiction;
  defaultEmail?: string;
}): React.JSX.Element {
  const [email, setEmail] = React.useState(defaultEmail);
  const waitlist = useJoinParentalWaitlist();

  if (waitlist.isSuccess) {
    return (
      <div className="flex flex-col gap-3" data-testid="waitlist-done">
        <h2 className="text-fg-0 text-base font-medium">You are on the list</h2>
        <p className="text-fg-2 text-sm">
          We will write to that address the moment a parental-consent flow is ready. Nothing else
          happens until then — there is no account and nothing stored beyond the address.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="blocked-minor">
      <p className="text-fg-1 text-sm">
        {BRAND.name} accounts start at {MINIMUM_AGE[jurisdiction]} where you are. We are building a
        way for a parent or guardian to give consent properly, and we would rather wait for that
        than get it wrong.
      </p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          waitlist.mutate(email);
        }}
      >
        <Field
          label="Email for the waiting list"
          htmlFor="waitlist-email"
          hint="Only used to tell you when this opens."
          {...(waitlist.isError ? { error: messageForError(waitlist.error) } : {})}
        >
          <Input
            id="waitlist-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>
        <Button
          type="submit"
          variant="secondary"
          disabled={waitlist.isPending}
          data-testid="waitlist-submit"
        >
          {waitlist.isPending ? "Adding…" : "Join the waiting list"}
        </Button>
      </form>
    </div>
  );
}

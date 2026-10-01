"use client";

/**
 * "Save as my default" (2026-10-01, OpusClip's "Save settings above as
 * default"): the start form's captions-and-clips choices saved for the whole
 * workspace, so every new video starts on them (`PUT /repurpose/defaults`).
 *
 * One line under the setup panel: whether these are the saved defaults, a
 * button to save them when they are not, and a way back to Aksharo's own.
 * Editors and up may change them; anyone else is told so when they try.
 */
import { BookmarkCheck } from "lucide-react";
import * as React from "react";

import { isApiError, type CreateRepurposeRunRequest } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import type { BrollOffer } from "@/components/broll/use-broll-library";

import { useRunDefaults, useSaveRunDefaults } from "@/components/repurpose/results/use-results";
import { runSetupRequest, type RunSetupValue } from "@/components/repurpose/RunSetupFields";

type Setup = CreateRepurposeRunRequest["setup"];

/**
 * A setup as the choices it stands for, so two setups that mean the same
 * compare equal however their optional fields were written.
 */
export function setupKey(setup: Setup): string {
  const discovery = setup.discovery;
  const manual = discovery.mode === "manual";
  return JSON.stringify([
    setup.sourceLanguage,
    setup.caption.outputLanguage ?? "same",
    setup.caption.scriptMode ?? "auto",
    setup.caption.styleId,
    manual ? "manual" : "ai",
    manual ? 0 : (discovery.requestedCandidates ?? 5),
    manual ? "" : (discovery.topic ?? ""),
    manual ? "" : (discovery.clipLength ?? "medium"),
    manual ? 0 : (discovery.skipIntroMs ?? 0),
    manual ? 0 : (discovery.skipOutroMs ?? 0),
    setup.automation ?? "manual",
    setup.brand === true,
    setup.broll === true,
  ]);
}

export interface RunDefaultsControlProps {
  readonly value: RunSetupValue;
  readonly brandKit: boolean;
  readonly broll?: BrollOffer;
}

export function RunDefaultsControl({
  value,
  brandKit,
  broll,
}: RunDefaultsControlProps): React.JSX.Element | null {
  const defaults = useRunDefaults();
  const save = useSaveRunDefaults();
  const [justSaved, setJustSaved] = React.useState(false);
  if (defaults.data === undefined) return null;

  const current = runSetupRequest(value, { brandKit, ...(broll === undefined ? {} : { broll }) });
  const saved = defaults.data.setup;
  const matches = saved !== null && setupKey(saved) === setupKey(current);
  const refused = isApiError(save.error) && save.error.status === 403;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
      data-testid="run-defaults"
      data-state={matches ? "saved" : saved === null ? "none" : "differs"}
    >
      <BookmarkCheck
        className={matches ? "size-4 text-accepted" : "size-4 text-fg-2"}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-[1_1_220px] text-fg-1" role="status">
        {matches
          ? justSaved
            ? "Saved. Every new video starts with these settings."
            : "These are your default settings."
          : saved === null
            ? "Start every new video with these settings?"
            : "These differ from your saved defaults."}
      </span>
      {matches ? null : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            save.mutate(current, {
              onSuccess: () => {
                setJustSaved(true);
              },
            });
          }}
          data-testid="run-defaults-save"
        >
          {save.isPending ? "Saving…" : "Save as my default"}
        </Button>
      )}
      {saved === null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={() => {
            setJustSaved(false);
            save.mutate(null);
          }}
          data-testid="run-defaults-reset"
        >
          Use Aksharo&apos;s defaults
        </Button>
      )}
      {save.isError ? (
        <p
          role="alert"
          className="m-0 w-full text-xs text-rejected"
          data-testid="run-defaults-error"
        >
          {refused
            ? "Only editors and owners can change the workspace's defaults."
            : "That did not save. Try again."}
        </p>
      ) : null}
    </div>
  );
}

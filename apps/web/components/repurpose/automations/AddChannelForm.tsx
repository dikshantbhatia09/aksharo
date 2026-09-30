"use client";

/**
 * "Connect a channel" (2026-10-02): paste a channel's link, see which channel
 * it is, choose the settings its videos will run with - the start form's own
 * panel (`RunSetupFields`), with the moments always found for you and
 * Autopilot always on - and save.
 *
 * The preview is a real answer from YouTube (through the API, cached there),
 * so what is saved is the channel the person saw. Editing the link after a
 * preview drops it: it was that link's channel. The settings appear only once
 * a channel is found, which is what keeps this page to one primary button.
 */
import { Check } from "lucide-react";
import * as React from "react";

import { Button, Field, Input } from "@montaj/ui";

import { AUTOMATIONS_COPY, automationRefusal } from "./automations-copy";
import { looksLikeChannelLink, normaliseChannelLink } from "./channel-link";
import { useCreateWatch, useResolveChannel, type ResolvedChannel } from "./use-automations";

import { useBrandKit } from "@/components/brand-kit/use-brand-kit";
import { brollOfferOf, useBrollLibrary } from "@/components/broll/use-broll-library";
import {
  EMPTY_RUN_SETUP,
  RunSetupFields,
  runSetupRequest,
  validateRunSetup,
  type RunSetupValue,
} from "@/components/repurpose/RunSetupFields";

const COPY = AUTOMATIONS_COPY.add;
const BACKFILL_CHOICES = [0, 1, 2, 3] as const;

export function AddChannelForm({
  atLimit = false,
  maxWatches = 20,
}: {
  /** The workspace follows as many channels as it may. */
  readonly atLimit?: boolean;
  readonly maxWatches?: number;
}): React.JSX.Element {
  const resolve = useResolveChannel();
  const create = useCreateWatch();
  // A saved brand kit offers the brand switch for the channel's runs (2026-10-02).
  const brandKit = useBrandKit();
  const hasBrandKit = brandKit.data?.exists === true;
  const broll = brollOfferOf(useBrollLibrary().data);
  const [link, setLink] = React.useState("");
  const [found, setFound] = React.useState<ResolvedChannel | null>(null);
  const [setup, setSetup] = React.useState<RunSetupValue>(EMPTY_RUN_SETUP);
  const [backfill, setBackfill] = React.useState(0);
  const [rights, setRights] = React.useState(false);
  const [showLinkProblem, setShowLinkProblem] = React.useState(false);
  const [showProblems, setShowProblems] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<string | null>(null);

  const normalised = normaliseChannelLink(link);
  const linkProblem =
    normalised === ""
      ? COPY.linkRequired
      : looksLikeChannelLink(normalised)
        ? undefined
        : COPY.linkInvalid;
  const problems = {
    ...validateRunSetup(setup),
    ...(rights ? {} : { rights: COPY.rightsRequired }),
  };
  const visible = showProblems ? problems : {};

  const find = (): void => {
    setError(null);
    setSaved(null);
    setShowLinkProblem(true);
    if (linkProblem !== undefined) return;
    resolve.mutate(normalised, {
      onSuccess: (channel) => {
        setFound(channel);
      },
      onError: (refused) => {
        setError(automationRefusal(refused));
      },
    });
  };

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    // Enter in the link field before anything is found finds it.
    if (found === null) {
      find();
      return;
    }
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    setError(null);
    create.mutate(
      {
        url: normalised,
        setup: runSetupRequest(setup, {
          forChannel: true,
          brandKit: hasBrandKit,
          ...(broll === undefined ? {} : { broll }),
        }),
        backfill,
        rightsAttested: true,
      },
      {
        onSuccess: (watch) => {
          setSaved(COPY.saved(watch.title));
          setLink("");
          setFound(null);
          setSetup(EMPTY_RUN_SETUP);
          setBackfill(0);
          setRights(false);
          setShowLinkProblem(false);
          setShowProblems(false);
        },
        onError: (refused) => {
          setError(automationRefusal(refused));
        },
      },
    );
  };

  const canSave = found !== null && found.watchId === null && !atLimit;

  return (
    <section aria-labelledby="watch-add-heading" className="flex flex-col gap-4">
      <h2 id="watch-add-heading" className="text-base text-fg-0">
        {COPY.heading}
      </h2>
      <form onSubmit={save} noValidate className="flex flex-col gap-5" data-testid="watch-add-form">
        <div className="space-y-3 rounded-md border border-border bg-surface p-4 sm:p-5">
          <Field
            label={COPY.linkLabel}
            htmlFor="watch-new-link"
            hint={COPY.linkHint}
            {...(showLinkProblem && linkProblem !== undefined ? { error: linkProblem } : {})}
          >
            <Input
              id="watch-new-link"
              inputMode="url"
              autoComplete="off"
              className="bg-sunken"
              placeholder={COPY.linkPlaceholder}
              value={link}
              data-testid="watch-link"
              aria-invalid={showLinkProblem && linkProblem !== undefined}
              aria-describedby={
                showLinkProblem && linkProblem !== undefined
                  ? "watch-new-link-error"
                  : "watch-new-link-hint"
              }
              onChange={(event) => {
                setLink(event.target.value);
                // A preview is of the link it was found for.
                setFound(null);
                setSaved(null);
              }}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={resolve.isPending || atLimit}
            data-testid="watch-find"
            onClick={find}
          >
            {resolve.isPending ? COPY.finding : COPY.find}
          </Button>
          {atLimit ? (
            <p className="text-xs text-fg-1" data-testid="watch-limit">
              {COPY.limit(maxWatches)}
            </p>
          ) : null}
          {found === null ? null : (
            <div
              className="flex min-w-0 items-center gap-2 rounded-sm border border-border bg-bg-2 px-3 py-2"
              data-testid="watch-preview"
            >
              <Check
                className="size-4 shrink-0 text-accepted"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-sm text-fg-0"
                  data-testid="watch-preview-title"
                >
                  {found.title}
                </span>
                <span className="block truncate text-xs text-fg-2">
                  {found.handle === null ? found.channelUrl : `@${found.handle}`}
                </span>
              </span>
            </div>
          )}
          {found !== null && found.watchId !== null ? (
            <p className="text-xs text-fg-1" data-testid="watch-already">
              {COPY.alreadyFollowed}
            </p>
          ) : null}
        </div>

        {canSave ? (
          <>
            <RunSetupFields
              value={setup}
              onChange={setSetup}
              problems={visible}
              forChannel
              brandKit={hasBrandKit}
              {...(broll === undefined ? {} : { broll })}
              idPrefix="watch-new"
            />

            <fieldset className="border-0 p-0">
              <legend className="text-sm font-medium text-fg-1">{COPY.backfillLegend}</legend>
              <p className="mt-0.5 text-xs text-fg-2">{COPY.backfillHint}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-5">
                {BACKFILL_CHOICES.map((count) => (
                  <label
                    key={count}
                    className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-fg-1"
                  >
                    <input
                      type="radio"
                      name="watch-new-backfill"
                      className="size-4 shrink-0 accent-accent"
                      value={count}
                      checked={backfill === count}
                      data-testid={`watch-backfill-${String(count)}`}
                      onChange={() => {
                        setBackfill(count);
                      }}
                    />
                    {COPY.backfill(count)}
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              {/* The whole row is the hit target, not just the 16 px box. */}
              <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm text-fg-1">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-accent"
                  checked={rights}
                  data-testid="watch-rights"
                  aria-invalid={"rights" in visible}
                  aria-describedby={"rights" in visible ? "watch-new-rights-error" : undefined}
                  onChange={(event) => {
                    setRights(event.target.checked);
                  }}
                />
                <span>{COPY.rights}</span>
              </label>
              {"rights" in visible ? (
                <p
                  id="watch-new-rights-error"
                  role="alert"
                  className="mt-1 text-xs text-rejected"
                  data-testid="watch-error-rights"
                >
                  {COPY.rightsRequired}
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {error === null ? null : (
          <p role="alert" className="m-0 text-sm text-rejected" data-testid="watch-add-error">
            {error}
          </p>
        )}
        {saved === null ? null : (
          <p role="status" className="m-0 text-sm text-fg-1" data-testid="watch-saved">
            {saved}
          </p>
        )}

        {canSave ? (
          <Button
            type="submit"
            variant="primary"
            disabled={create.isPending}
            className="self-start"
            data-testid="watch-save"
          >
            {create.isPending ? COPY.saving : COPY.save}
          </Button>
        ) : null}
      </form>
    </section>
  );
}

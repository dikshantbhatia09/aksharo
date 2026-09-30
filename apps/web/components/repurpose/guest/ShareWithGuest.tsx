"use client";

/**
 * "Share with a guest" (2026-10-05): a link a podcaster sends their guest, who
 * opens it on their phone, with no account, to download the clips they appear
 * in - every size with and without captions, the images, the words to post -
 * and the list of the links already made, with their visits and downloads, to
 * turn one off.
 *
 *   * Editors and up make and turn off guest links (a link hands over files
 *     the team chose, never a decision); viewers see no button.
 *   * Every clip (clips made later too), or a choice of them; the guest's name
 *     for the greeting; 1-30 days (14); the dubbed versions when the run has
 *     any and the person asks.
 *   * The link is shown once, as it is made (the server keeps only a hash of
 *     it): copy or share it then. A lost link is turned off and made again.
 *   * Turning one off cannot be undone, so it asks first (`ConfirmAction`).
 *
 * Renders nothing while public links are switched off for this deployment.
 */
import { Send, Share2 } from "lucide-react";
import * as React from "react";

import { surfaceEnabled } from "@montaj/config";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmAction,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@montaj/ui";

import { GUEST_LINK_COPY, describeGuestLinkError } from "./guest-copy";
import {
  useCreateGuestLink,
  useGuestLinks,
  useRevokeGuestLink,
  type CreatedGuestLink,
  type GuestLink,
} from "./use-guest-links";

import { useRuntimeConfig } from "@/components/providers";
import { copyText } from "@/components/repurpose/copy-text";
import { sinceWords } from "@/components/repurpose/review/review-copy";

const EXPIRY_CHOICES = [1, 3, 7, 14, 30] as const;
const SELECT_CLASS =
  "h-11 w-full rounded-sm border border-neutral-600 bg-sunken px-3 text-sm text-fg-0 hover:border-border-hover sm:h-9";

/** A clip the dialog can share: as the run page lists it. */
export interface GuestClipChoice {
  readonly id: string;
  readonly title: string;
}

export interface ShareWithGuestProps {
  readonly runId: string;
  /** The run's clips, as its page lists them (a removed moment's clip is not one). */
  readonly clips: readonly GuestClipChoice[];
  /** Editors and up: the review permissions' `revokeLinks`, the same bar. */
  readonly canShare: boolean;
  /** The workspace holds a clip back until it is approved. */
  readonly needsApproval: boolean;
  /** The run has dubbed versions to offer. */
  readonly hasDubs: boolean;
}

function dateWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(date);
}

export function ShareWithGuest(props: ShareWithGuestProps): React.JSX.Element | null {
  const config = useRuntimeConfig();
  const [open, setOpen] = React.useState(false);
  if (!surfaceEnabled("publicShares", config.flags)) return null;
  if (!props.canShare) return null;
  return (
    <div data-testid="share-with-guest">
      <Button
        variant="secondary"
        size="sm"
        className="h-11 sm:h-8"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="share-with-guest-open"
      >
        <Send strokeWidth={1.75} aria-hidden="true" />
        {GUEST_LINK_COPY.button}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[88vh] max-w-lg overflow-y-auto"
          data-testid="share-with-guest-dialog"
        >
          <DialogHeader>
            <DialogTitle>{GUEST_LINK_COPY.title}</DialogTitle>
            <DialogDescription>{GUEST_LINK_COPY.description}</DialogDescription>
          </DialogHeader>
          {open ? (
            <ShareBody
              {...props}
              onDone={() => {
                setOpen(false);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ShareBody({
  runId,
  clips,
  needsApproval,
  hasDubs,
  onDone,
}: ShareWithGuestProps & { readonly onDone: () => void }): React.JSX.Element {
  const links = useGuestLinks(runId, true);
  const listed = links.data?.links ?? [];
  const create = useCreateGuestLink();
  const [guestName, setGuestName] = React.useState("");
  const [allClips, setAllClips] = React.useState(true);
  const [picked, setPicked] = React.useState<readonly string[]>(() => clips.map((clip) => clip.id));
  const [days, setDays] = React.useState<number>(14);
  const [includeDubs, setIncludeDubs] = React.useState(false);
  const [noneChosen, setNoneChosen] = React.useState(false);
  const [made, setMade] = React.useState<CreatedGuestLink | null>(null);

  return (
    <>
      <div className="flex flex-col gap-5">
        {made !== null ? (
          <MadeLink link={made} />
        ) : (
          <form
            className="flex flex-col gap-4"
            id="share-with-guest-form"
            onSubmit={(event) => {
              event.preventDefault();
              const chosen = clips.map((clip) => clip.id).filter((id) => picked.includes(id));
              if (!allClips && chosen.length === 0) {
                setNoneChosen(true);
                return;
              }
              setNoneChosen(false);
              create.mutate(
                {
                  runId,
                  allClips,
                  clipIds: chosen,
                  guestName,
                  expiresInDays: days,
                  includeDubs: hasDubs && includeDubs,
                },
                {
                  onSuccess: (link) => {
                    setMade(link);
                  },
                },
              );
            }}
          >
            <Field
              label={GUEST_LINK_COPY.nameLabel}
              htmlFor="guest-link-name"
              hint={GUEST_LINK_COPY.nameHint}
            >
              <Input
                id="guest-link-name"
                value={guestName}
                maxLength={60}
                autoComplete="off"
                placeholder={GUEST_LINK_COPY.namePlaceholder}
                onChange={(event) => {
                  setGuestName(event.target.value);
                }}
                data-testid="guest-link-name"
              />
            </Field>

            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-sm font-medium text-fg-1">
                {GUEST_LINK_COPY.pickClips}
              </legend>
              <label className="flex min-h-11 items-start gap-3 text-sm text-fg-0 sm:min-h-0">
                <Checkbox
                  className="mt-0.5"
                  checked={allClips}
                  onCheckedChange={(value) => {
                    setAllClips(value === true);
                  }}
                  data-testid="guest-link-all-clips"
                />
                <span>{GUEST_LINK_COPY.allClips}</span>
              </label>
              {allClips ? null : (
                <ul
                  className="m-0 flex max-h-56 list-none flex-col gap-1 overflow-y-auto rounded-sm border border-border p-2"
                  data-testid="guest-link-clips"
                >
                  {clips.map((clip) => (
                    <li key={clip.id}>
                      <label className="flex min-h-11 items-start gap-3 text-sm text-fg-0 sm:min-h-8">
                        <Checkbox
                          className="mt-0.5"
                          checked={picked.includes(clip.id)}
                          onCheckedChange={(value) => {
                            setPicked((current) =>
                              value === true
                                ? [...current.filter((id) => id !== clip.id), clip.id]
                                : current.filter((id) => id !== clip.id),
                            );
                          }}
                          data-testid={`guest-link-clip-${clip.id}`}
                        />
                        <span className="min-w-0 break-words">{clip.title}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {noneChosen ? (
                <p role="alert" className="m-0 text-sm text-rejected">
                  {GUEST_LINK_COPY.noneChosen}
                </p>
              ) : null}
            </fieldset>

            <Field label={GUEST_LINK_COPY.expiresLabel} htmlFor="guest-link-days">
              <select
                id="guest-link-days"
                className={SELECT_CLASS}
                value={days}
                onChange={(event) => {
                  setDays(Number(event.target.value));
                }}
                data-testid="guest-link-days"
              >
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {GUEST_LINK_COPY.days(choice)}
                  </option>
                ))}
              </select>
            </Field>

            {hasDubs ? (
              <label className="flex min-h-11 items-start gap-3 text-sm text-fg-0 sm:min-h-0">
                <Checkbox
                  className="mt-0.5"
                  checked={includeDubs}
                  onCheckedChange={(value) => {
                    setIncludeDubs(value === true);
                  }}
                  data-testid="guest-link-include-dubs"
                />
                <span>
                  {GUEST_LINK_COPY.includeDubs}
                  <span className="block text-xs text-fg-2">{GUEST_LINK_COPY.includeDubsHint}</span>
                </span>
              </label>
            ) : null}

            {needsApproval ? (
              <p className="m-0 text-sm text-fg-1" data-testid="guest-link-approval-note">
                {GUEST_LINK_COPY.approvalNote}
              </p>
            ) : null}

            {create.isError ? (
              <p role="alert" className="m-0 text-sm text-rejected" data-testid="guest-link-error">
                {describeGuestLinkError(create.error)}
              </p>
            ) : null}
          </form>
        )}

        <section className="flex flex-col gap-2" aria-label={GUEST_LINK_COPY.linksHeading}>
          <h3 className="m-0 text-xs font-semibold tracking-wide text-fg-2 uppercase">
            {GUEST_LINK_COPY.linksHeading}
          </h3>
          {links.isError ? (
            <p role="alert" className="m-0 text-sm text-rejected">
              {describeGuestLinkError(links.error)}
            </p>
          ) : listed.length === 0 ? (
            <p className="m-0 text-sm text-fg-2">
              {links.isPending ? "…" : GUEST_LINK_COPY.noLinks}
            </p>
          ) : (
            <ul className="m-0 list-none divide-y divide-border p-0" data-testid="guest-links">
              {listed.map((link) => (
                <LinkRow key={link.id} runId={runId} link={link} />
              ))}
            </ul>
          )}
        </section>
      </div>
      <DialogFooter>
        {made === null ? (
          <>
            <Button variant="ghost" onClick={onDone}>
              {GUEST_LINK_COPY.done}
            </Button>
            <Button
              type="submit"
              form="share-with-guest-form"
              variant="primary"
              disabled={create.isPending}
              data-testid="guest-link-create"
            >
              <Send strokeWidth={1.75} aria-hidden="true" />
              {create.isPending ? GUEST_LINK_COPY.creating : GUEST_LINK_COPY.create}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onDone} data-testid="guest-link-done">
            {GUEST_LINK_COPY.done}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** The link as it is made: the one time it can be copied. */
function MadeLink({ link }: { readonly link: CreatedGuestLink }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="flex flex-col gap-3" data-testid="guest-link-made">
      <p className="m-0 text-sm text-fg-1">{GUEST_LINK_COPY.created}</p>
      <Input
        readOnly
        value={link.url}
        aria-label={GUEST_LINK_COPY.copy}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        data-testid="guest-link-url"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className="h-11 sm:h-9"
          onClick={() => {
            void copyText(link.url).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
          data-testid="guest-link-copy"
        >
          {copied ? GUEST_LINK_COPY.copied : GUEST_LINK_COPY.copy}
        </Button>
        {canShare ? (
          <Button
            variant="ghost"
            className="h-11 sm:h-9"
            onClick={() => {
              void navigator.share({ url: link.url }).catch(() => undefined);
            }}
          >
            <Share2 strokeWidth={1.75} aria-hidden="true" />
            {GUEST_LINK_COPY.shareNative}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function LinkRow({
  runId,
  link,
}: {
  readonly runId: string;
  readonly link: GuestLink;
}): React.JSX.Element {
  const revoke = useRevokeGuestLink();
  const name = link.guestName === null ? `…${link.hint}` : GUEST_LINK_COPY.forGuest(link.guestName);
  return (
    <li
      className="flex flex-col gap-1 py-2"
      data-testid={`guest-link-${link.id}`}
      data-status={link.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 flex-[1_1_180px]">
          <span className="block truncate text-sm text-fg-0">
            {name}
            {link.guestName === null ? null : (
              <span className="font-mono text-2xs text-fg-2"> …{link.hint}</span>
            )}
          </span>
          <span className="block text-xs text-fg-2" data-testid={`guest-link-${link.id}-stats`}>
            {link.status === "live"
              ? `${GUEST_LINK_COPY.status.live} ${GUEST_LINK_COPY.until(dateWords(link.expiresAt))}`
              : GUEST_LINK_COPY.status[link.status]}
            {" · "}
            {GUEST_LINK_COPY.clips(link.allClips, link.clipCount)}
            {" · "}
            {GUEST_LINK_COPY.visits(link.visits)}
            {link.lastVisitAt === null ? "" : ` (${sinceWords(link.lastVisitAt)})`}
            {" · "}
            {GUEST_LINK_COPY.downloads(link.downloads)}
          </span>
        </span>
        {link.status === "live" ? (
          <ConfirmAction
            trigger={
              <Button
                variant="ghost"
                size="sm"
                className="h-11 sm:h-8"
                disabled={revoke.isPending}
                aria-label={`${GUEST_LINK_COPY.revoke}: ${name}`}
                data-testid={`guest-link-revoke-${link.id}`}
              >
                {GUEST_LINK_COPY.revoke}
              </Button>
            }
            title={GUEST_LINK_COPY.revokeTitle}
            description={GUEST_LINK_COPY.revokeDescription}
            confirmLabel={GUEST_LINK_COPY.revoke}
            confirmTestId={`guest-link-revoke-confirm-${link.id}`}
            onConfirm={() => {
              revoke.mutate({ runId, linkId: link.id });
            }}
          />
        ) : (
          <Badge tone="neutral">{GUEST_LINK_COPY.status[link.status]}</Badge>
        )}
      </div>
      {revoke.isError ? (
        <p role="alert" className="m-0 text-xs text-rejected">
          {describeGuestLinkError(revoke.error)}
        </p>
      ) : null}
    </li>
  );
}

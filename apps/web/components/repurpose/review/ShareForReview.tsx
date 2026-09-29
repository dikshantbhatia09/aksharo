"use client";

/**
 * "Share for review" (2026-10-03): a link a client opens on their phone, with
 * no account, to watch this run's finished clips and approve them or ask for
 * changes - and the list of the links already made, to turn one off.
 *
 *   * Only an owner or admin makes a link: a client's approval counts, so a
 *     link hands approval to someone else. Editors see the links and can turn
 *     them off; viewers see no button.
 *   * The link is shown once, as it is made (the server keeps only a hash of
 *     it): copy or share it then. A lost link is turned off and made again.
 *   * Turning one off cannot be undone, so it asks first (`ConfirmAction`).
 *
 * Renders nothing while public links are switched off for this deployment.
 */
import { Link2, Share2 } from "lucide-react";
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

import { SHARE_COPY, describeReviewError, sinceWords } from "./review-copy";
import {
  useCreateReviewLink,
  useReviewLinks,
  useRevokeReviewLink,
  type CreatedReviewLink,
  type ReviewLink,
  type ReviewPermissions,
} from "./use-review";

import { useRuntimeConfig } from "@/components/providers";

const EXPIRY_CHOICES = [1, 3, 7, 14, 30] as const;
const SELECT_CLASS =
  "h-11 w-full rounded-sm border border-neutral-600 bg-sunken px-3 text-sm text-fg-0 hover:border-border-hover sm:h-9";

export interface ShareForReviewProps {
  readonly runId: string;
  readonly permissions: ReviewPermissions | undefined;
}

function dateWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(date);
}

export function ShareForReview({
  runId,
  permissions,
}: ShareForReviewProps): React.JSX.Element | null {
  const config = useRuntimeConfig();
  const [open, setOpen] = React.useState(false);
  if (!surfaceEnabled("publicShares", config.flags)) return null;
  if (permissions === undefined || !permissions.revokeLinks) return null;
  return (
    <div data-testid="share-for-review">
      <Button
        variant="secondary"
        size="sm"
        className="h-11 sm:h-8"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="share-for-review-open"
      >
        <Share2 strokeWidth={1.75} aria-hidden="true" />
        {SHARE_COPY.button}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[88vh] max-w-lg overflow-y-auto"
          data-testid="share-for-review-dialog"
        >
          <DialogHeader>
            <DialogTitle>{SHARE_COPY.title}</DialogTitle>
            <DialogDescription>{SHARE_COPY.description}</DialogDescription>
          </DialogHeader>
          {open ? (
            <ShareBody
              runId={runId}
              permissions={permissions}
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
  permissions,
  onDone,
}: {
  readonly runId: string;
  readonly permissions: ReviewPermissions;
  readonly onDone: () => void;
}): React.JSX.Element {
  const links = useReviewLinks(runId, true);
  const listed = links.data?.links ?? [];
  const create = useCreateReviewLink();
  const [days, setDays] = React.useState<number>(7);
  const [requireName, setRequireName] = React.useState(true);
  const [label, setLabel] = React.useState("");
  const [made, setMade] = React.useState<CreatedReviewLink | null>(null);

  return (
    <>
      <div className="flex flex-col gap-5">
        {made !== null ? (
          <MadeLink link={made} />
        ) : permissions.shareLinks ? (
          <form
            className="flex flex-col gap-4"
            id="share-for-review-form"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                { runId, expiresInDays: days, requireName, label },
                {
                  onSuccess: (link) => {
                    setMade(link);
                  },
                },
              );
            }}
          >
            <Field label={SHARE_COPY.expiresLabel} htmlFor="review-link-days">
              <select
                id="review-link-days"
                className={SELECT_CLASS}
                value={days}
                onChange={(event) => {
                  setDays(Number(event.target.value));
                }}
                data-testid="review-link-days"
              >
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {SHARE_COPY.days(choice)}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex min-h-11 items-start gap-3 text-sm text-fg-0 sm:min-h-0">
              <Checkbox
                className="mt-0.5"
                checked={requireName}
                onCheckedChange={(value) => {
                  setRequireName(value === true);
                }}
                data-testid="review-link-require-name"
              />
              <span>
                {SHARE_COPY.requireName}
                <span className="block text-xs text-fg-2">{SHARE_COPY.requireNameHint}</span>
              </span>
            </label>
            <Field label={SHARE_COPY.labelLabel} htmlFor="review-link-label">
              <Input
                id="review-link-label"
                value={label}
                maxLength={80}
                placeholder={SHARE_COPY.labelPlaceholder}
                onChange={(event) => {
                  setLabel(event.target.value);
                }}
              />
            </Field>
            {create.isError ? (
              <p role="alert" className="m-0 text-sm text-rejected" data-testid="review-link-error">
                {describeReviewError(create.error)}
              </p>
            ) : null}
          </form>
        ) : (
          <p className="m-0 text-sm text-fg-1" data-testid="review-link-admin-only">
            {SHARE_COPY.adminOnly}
          </p>
        )}

        <section className="flex flex-col gap-2" aria-label={SHARE_COPY.linksHeading}>
          <h3 className="m-0 text-xs font-semibold tracking-wide text-fg-2 uppercase">
            {SHARE_COPY.linksHeading}
          </h3>
          {links.isError ? (
            <p role="alert" className="m-0 text-sm text-rejected">
              {describeReviewError(links.error)}
            </p>
          ) : listed.length === 0 ? (
            <p className="m-0 text-sm text-fg-2">{links.isPending ? "…" : SHARE_COPY.noLinks}</p>
          ) : (
            <ul className="m-0 list-none divide-y divide-border p-0" data-testid="review-links">
              {listed.map((link) => (
                <LinkRow
                  key={link.id}
                  runId={runId}
                  link={link}
                  canRevoke={permissions.revokeLinks}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
      <DialogFooter>
        {made === null && permissions.shareLinks ? (
          <>
            <Button variant="ghost" onClick={onDone}>
              {SHARE_COPY.done}
            </Button>
            <Button
              type="submit"
              form="share-for-review-form"
              variant="primary"
              disabled={create.isPending}
              data-testid="review-link-create"
            >
              <Link2 strokeWidth={1.75} aria-hidden="true" />
              {create.isPending ? SHARE_COPY.creating : SHARE_COPY.create}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onDone} data-testid="review-link-done">
            {SHARE_COPY.done}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** The link as it is made: the one time it can be copied. */
function MadeLink({ link }: { readonly link: CreatedReviewLink }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="flex flex-col gap-3" data-testid="review-link-made">
      <p className="m-0 text-sm text-fg-1">{SHARE_COPY.created}</p>
      <Input
        readOnly
        value={link.url}
        aria-label={SHARE_COPY.copy}
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        data-testid="review-link-url"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className="h-11 sm:h-9"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(link.url)
              .then(() => {
                setCopied(true);
              })
              .catch(() => undefined);
          }}
          data-testid="review-link-copy"
        >
          {copied ? SHARE_COPY.copied : SHARE_COPY.copy}
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
            {SHARE_COPY.shareNative}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function LinkRow({
  runId,
  link,
  canRevoke,
}: {
  readonly runId: string;
  readonly link: ReviewLink;
  readonly canRevoke: boolean;
}): React.JSX.Element {
  const revoke = useRevokeReviewLink();
  const name = link.label ?? `…${link.hint}`;
  return (
    <li
      className="flex flex-col gap-1 py-2"
      data-testid={`review-link-${link.id}`}
      data-status={link.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 flex-[1_1_180px]">
          <span className="block truncate text-sm text-fg-0">
            {name}
            {link.label === null ? null : (
              <span className="font-mono text-2xs text-fg-2"> …{link.hint}</span>
            )}
          </span>
          <span className="block text-xs text-fg-2">
            {link.status === "live"
              ? `${SHARE_COPY.status.live} ${SHARE_COPY.until(dateWords(link.expiresAt))}`
              : SHARE_COPY.status[link.status]}
            {" · "}
            {link.visits === 0 ? SHARE_COPY.never : SHARE_COPY.visits(link.visits)}
            {link.lastVisitAt === null ? "" : ` (${sinceWords(link.lastVisitAt)})`}
            {" · "}
            {SHARE_COPY.said(link.decisions, link.comments)}
          </span>
        </span>
        {link.status === "live" ? (
          canRevoke ? (
            <ConfirmAction
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 sm:h-8"
                  disabled={revoke.isPending}
                  aria-label={`${SHARE_COPY.revoke}: ${name}`}
                  data-testid={`review-link-revoke-${link.id}`}
                >
                  {SHARE_COPY.revoke}
                </Button>
              }
              title={SHARE_COPY.revokeTitle}
              description={SHARE_COPY.revokeDescription}
              confirmLabel={SHARE_COPY.revoke}
              confirmTestId={`review-link-revoke-confirm-${link.id}`}
              onConfirm={() => {
                revoke.mutate({ runId, linkId: link.id });
              }}
            />
          ) : null
        ) : (
          <Badge tone="neutral">{SHARE_COPY.status[link.status]}</Badge>
        )}
      </div>
      {revoke.isError ? (
        <p role="alert" className="m-0 text-xs text-rejected">
          {describeReviewError(revoke.error)}
        </p>
      ) : null}
    </li>
  );
}

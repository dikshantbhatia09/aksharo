"use client";

import Link from "next/link";
import * as React from "react";

import { useApplyAffiliate, useMyAffiliate, useMyAffiliateStats } from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  ProgressBar,
  Skeleton,
  toast,
} from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";
import { INLINE_LINK_CLASS } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";

/** Shown wherever the programme would otherwise ask for, or quote, money (F07-E9). */
const NO_PAYOUTS_NOTICE =
  "Payouts are not configured in this build; your referral stats still count.";

/** The ASCI disclosure clause, verbatim (04 §Affiliate). Never paraphrase this text. */
export const ASCI_DISCLOSURE_CLAUSE =
  "If you promote Aksharo in exchange for commission, credits or any other benefit, you " +
  "have a material connection with us and must disclose it. Every post, story, video, live " +
  "stream or comment promoting Aksharo must carry a clear disclosure label a viewer sees " +
  "upfront and cannot miss — not buried in a hashtag block, not behind ‘more’, and " +
  "in the same language as the post. For video, the disclosure must stay on screen long " +
  "enough to be read. You must follow the ASCI Guidelines for Influencer Advertising in " +
  "Digital Media as amended. We may withhold or claw back commission for undisclosed " +
  "promotion.";

function formatRupees(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  // "Pending" is a waiting state, so it takes the proposed/warning signal
  // rather than the brand accent (DESIGN.md > accent budget).
  const tone = status === "approved" ? "accepted" : status === "pending" ? "warning" : "rejected";
  const label =
    status === "approved"
      ? "Approved"
      : status === "pending"
        ? "Pending review"
        : status === "suspended_review"
          ? "Under review"
          : status === "suspended"
            ? "Suspended"
            : "Rejected";
  return <Badge tone={tone as "accepted" | "warning" | "rejected"}>{label}</Badge>;
}

/**
 * `/affiliate` (brief §6): apply form (PAN + disclosure acceptance), or, once
 * approved, the link/code, clicks/sign-ups/paid/pending/paid-out stats, tier
 * progress toward `while_subscribed_30` at 10 active referrals, and
 * FY-to-date gross/TDS/net.
 */
export function AffiliateView(): React.JSX.Element {
  const affiliate = useMyAffiliate();
  const status = affiliate.data?.status;

  // One title for every state of the page (loading, error, apply, dashboard):
  // it used to be repeated inside three branches, and the loading and error
  // states had none at all.
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <PageHeader
        title="Refer & earn"
        description={
          affiliate.data === null
            ? `Apply to the ${BRAND.name} affiliate programme (India only at launch).`
            : affiliate.data === undefined
              ? `The ${BRAND.name} affiliate programme.`
              : "Your referral link, the people it brought in, and what they earned you."
        }
        actions={status === undefined ? undefined : <StatusBadge status={status} />}
      />
      <AffiliateBody />
    </div>
  );
}

function AffiliateBody(): React.JSX.Element {
  const { razorpayEnabled } = useRuntimeConfig();
  const affiliate = useMyAffiliate();
  const isApproved = affiliate.data?.status === "approved";
  const stats = useMyAffiliateStats(isApproved);

  if (affiliate.isPending) {
    return (
      <div className="flex flex-col gap-4" data-testid="affiliate-loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (affiliate.isError) {
    return (
      <p className="text-rejected text-sm" role="alert">
        {messageForError(affiliate.error)}
      </p>
    );
  }

  if (affiliate.data === null) {
    return <ApplyForm />;
  }

  return (
    <div className="flex flex-col gap-6" data-testid="affiliate-dashboard">
      {affiliate.data.status === "pending" ? (
        <Card className="flex flex-col gap-2">
          <p className="text-fg-0 text-sm">
            Your application is under review. You get an email as soon as it is approved.
          </p>
        </Card>
      ) : null}

      {affiliate.data.status === "suspended" || affiliate.data.status === "suspended_review" ? (
        <Card className="flex flex-col gap-2">
          <p className="text-rejected text-sm" role="alert">
            {affiliate.data.status === "suspended_review"
              ? "Your account is under review for unusual referral activity. No commission accrues while it is."
              : "Your affiliate account is suspended. Contact support for details."}
          </p>
        </Card>
      ) : null}

      {isApproved ? (
        <>
          <Card className="flex flex-col gap-3">
            <h2 className="text-fg-0 text-base font-semibold">Your link</h2>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="Your referral link"
                value={affiliate.data.referralLink}
                data-testid="affiliate-link"
              />
              <Button
                variant="primary"
                onClick={() => {
                  const referralLink = affiliate.data?.referralLink ?? "";
                  void navigator.clipboard.writeText(referralLink);
                  toast.success("Link copied");
                }}
              >
                Copy link
              </Button>
            </div>
            <p className="text-fg-2 text-xs">
              Code <span className="font-mono">{affiliate.data.code}</span> — entering it at sign-up
              or checkout always credits you, even without a click.
            </p>
          </Card>

          {stats.isPending ? (
            <Skeleton className="h-56" />
          ) : stats.isError ? (
            <p className="text-rejected text-sm" role="alert">
              {messageForError(stats.error)}
            </p>
          ) : stats.data === undefined ? null : (
            <>
              <Card
                className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4"
                data-testid="affiliate-stats"
              >
                <Stat label="Clicks" value={stats.data.clicks.toString()} />
                <Stat label="Sign-ups" value={stats.data.signups.toString()} />
                <Stat label="Paid referrals" value={stats.data.paidReferrals.toString()} />
                <Stat label="Active referrals" value={stats.data.activeReferrals.toString()} />
                {/* The counts are real in any build; the commission columns are
                    only meaningful with a payout rail behind them (F07-E9). */}
                {razorpayEnabled ? (
                  <>
                    <Stat label="Pending" value={formatRupees(stats.data.pendingCommissionMinor)} />
                    <Stat
                      label="Available"
                      value={formatRupees(stats.data.availableCommissionMinor)}
                    />
                    <Stat label="Paid out" value={formatRupees(stats.data.paidOutMinor)} />
                  </>
                ) : null}
                <Stat
                  label="Tier"
                  value={stats.data.tier === "while_subscribed_30" ? "30% (top tier)" : "Standard"}
                />
              </Card>

              {stats.data.tier !== "while_subscribed_30" ? (
                <Card className="flex flex-col gap-2">
                  <h2 className="text-fg-0 text-base font-semibold">Tier progress</h2>
                  <p className="text-fg-2 text-sm">
                    {stats.data.activeReferrals} of {stats.data.activeReferralsForTierUpgrade}{" "}
                    active referrals — reach {stats.data.activeReferralsForTierUpgrade} to unlock
                    30% on every payment for as long as each referral stays subscribed.
                  </p>
                  <ProgressBar
                    label="Tier progress"
                    value={Math.min(
                      100,
                      Math.round(
                        (stats.data.activeReferrals / stats.data.activeReferralsForTierUpgrade) *
                          100,
                      ),
                    )}
                  />
                </Card>
              ) : null}

              {razorpayEnabled ? (
                <Card className="flex flex-col gap-2" data-testid="affiliate-fy-tds">
                  <h2 className="text-fg-0 text-base font-semibold">
                    FY {stats.data.fyLabel} to date
                  </h2>
                  <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-fg-2">Gross</dt>
                      <dd className="text-fg-0 font-medium">
                        {formatRupees(stats.data.fyGrossMinor)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-fg-2">TDS (194H)</dt>
                      <dd className="text-fg-0 font-medium">
                        {formatRupees(stats.data.fyTdsMinor)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-fg-2">Net</dt>
                      <dd className="text-fg-0 font-medium">
                        {formatRupees(stats.data.fyNetMinor)}
                      </dd>
                    </div>
                  </dl>
                  <p className="text-fg-2 text-xs">
                    TDS applies once your FY-to-date gross crosses ₹20,000 — 2% with a verified PAN,
                    20% without one.
                  </p>
                </Card>
              ) : (
                <Card className="flex flex-col gap-2" data-testid="affiliate-no-payouts">
                  <p className="text-fg-2 text-sm">{NO_PAYOUTS_NOTICE}</p>
                </Card>
              )}
            </>
          )}

          <Card className="flex flex-col gap-2">
            <h2 className="text-fg-0 text-base font-semibold">Assets and programme rules</h2>
            <p className="text-fg-2 text-sm">
              Scripts, demo cuts, disclosure labels and the full programme rules.
            </p>
            <Link href="/affiliate/assets" className={`${INLINE_LINK_CLASS} self-start text-sm`}>
              Open the asset pack
            </Link>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-fg-2 text-xs">{label}</span>
      <span className="text-fg-0 text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function ApplyForm(): React.JSX.Element {
  const { razorpayEnabled } = useRuntimeConfig();
  const apply = useApplyAffiliate();
  const [legalName, setLegalName] = React.useState("");
  const [pan, setPan] = React.useState("");
  const [gstin, setGstin] = React.useState("");
  const [vpa, setVpa] = React.useState("");
  const [accountHolderName, setAccountHolderName] = React.useState("");
  const [accepted, setAccepted] = React.useState(false);

  const panValid = PAN_PATTERN.test(pan.toUpperCase());
  const canSubmit =
    legalName.trim().length > 0 &&
    panValid &&
    vpa.trim().length > 0 &&
    accountHolderName.trim().length > 0 &&
    accepted &&
    !apply.isPending;

  // PAN, GSTIN, UPI VPA and an account-holder name are payout details. Asking a
  // free build for them collects sensitive identity data for a payment that
  // cannot be made, and the Apply button behind them could never be satisfied
  // anyway — so the whole form gives way to the notice (F07-E9).
  if (!razorpayEnabled) {
    return (
      <div className="flex max-w-xl flex-col gap-6" data-testid="affiliate-apply-form">
        <Card className="flex flex-col gap-2" data-testid="affiliate-no-payouts">
          <p className="text-fg-2 text-sm">{NO_PAYOUTS_NOTICE}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex max-w-xl flex-col gap-6" data-testid="affiliate-apply-form">
      <Card className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-base font-semibold">Payout details</h2>
        <Field label="Legal name" htmlFor="aff-legal-name">
          <Input
            id="aff-legal-name"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
          />
        </Field>
        <Field
          label="PAN"
          htmlFor="aff-pan"
          {...(pan.length > 0 && !panValid ? { error: "PAN must match AAAAA9999A." } : {})}
        >
          <Input
            id="aff-pan"
            value={pan}
            placeholder="AAAAA9999A"
            onChange={(e) => setPan(e.target.value.toUpperCase())}
            data-testid="affiliate-pan-input"
          />
        </Field>
        <Field label="GSTIN (optional)" htmlFor="aff-gstin">
          <Input
            id="aff-gstin"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="UPI VPA" htmlFor="aff-vpa">
          <Input
            id="aff-vpa"
            value={vpa}
            placeholder="you@upi"
            onChange={(e) => setVpa(e.target.value)}
          />
        </Field>
        <Field label="Account holder name" htmlFor="aff-holder">
          <Input
            id="aff-holder"
            value={accountHolderName}
            onChange={(e) => setAccountHolderName(e.target.value)}
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-fg-0 text-base font-semibold">Disclosure requirement</h2>
        <p className="text-fg-2 text-sm" data-testid="affiliate-asci-clause">
          {ASCI_DISCLOSURE_CLAUSE}
        </p>
        <label className="flex min-h-8 items-start gap-2 text-sm">
          <Checkbox
            checked={accepted}
            onCheckedChange={(checked) => setAccepted(checked === true)}
            data-testid="affiliate-accept-disclosure"
          />
          <span className="text-fg-0">
            I have read and will follow this disclosure requirement.
          </span>
        </label>
      </Card>

      <Button
        variant="primary"
        className="self-start"
        disabled={!canSubmit}
        data-testid="affiliate-apply-submit"
        onClick={() => {
          apply.mutate(
            {
              legalName: legalName.trim(),
              pan: pan.toUpperCase(),
              ...(gstin.trim() === "" ? {} : { gstin: gstin.trim() }),
              payoutMethod: {
                rail: "upi",
                vpaOrAccountNumber: vpa.trim(),
                accountHolderName: accountHolderName.trim(),
              },
              acceptedDisclosure: true,
            },
            {
              onError: (error: Error) => {
                toast.error("Could not submit your application", {
                  description: messageForError(error),
                });
              },
            },
          );
        }}
      >
        {apply.isPending ? "Submitting…" : "Send application"}
      </Button>
    </div>
  );
}

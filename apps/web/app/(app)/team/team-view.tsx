"use client";

import { Users } from "lucide-react";
import * as React from "react";

import {
  useChangeMemberRole,
  useClientTags,
  useEntitlement,
  useInviteMember,
  useMembers,
  useRemoveMember,
  useSession,
  useTransferOwnership,
} from "@montaj/api-client";
import type { MemberView, WorkspaceRole } from "@montaj/api-client";
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Skeleton,
  toast,
} from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";
import { messageForError } from "@/lib/errors";

const ROLES: WorkspaceRole[] = ["viewer", "editor", "admin"];

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
  admin: "Admin",
  owner: "Owner",
};

/**
 * Team (brief §1, §4): members, invites, roles, seats and a cost preview, plus
 * client tags for an Agency workspace and ownership transfer for the owner.
 *
 * Seat billing itself and pooled-credit granting happen server-side
 * (`SeatBillingService`, reacting to the same invite-accept / remove events
 * this page's mutations trigger) — this page only shows the CURRENT numbers
 * (`useEntitlement`), never computes a price client-side.
 */
export function TeamView(): React.JSX.Element {
  // F07 follow-up (orchestrator): a payments-off build must not print a seat
  // price it cannot charge — same razorpayEnabled gate as every billing surface.
  const { razorpayEnabled } = useRuntimeConfig();
  const session = useSession();
  const members = useMembers();
  const entitlement = useEntitlement();
  const clientTags = useClientTags();
  const invite = useInviteMember();
  const changeRole = useChangeMemberRole();
  const remove = useRemoveMember();
  const transfer = useTransferOwnership();

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteRole, setInviteRole] = React.useState<WorkspaceRole>("editor");

  const [transferOpen, setTransferOpen] = React.useState(false);
  const [transferTarget, setTransferTarget] = React.useState<string | null>(null);
  const [confirmToken, setConfirmToken] = React.useState("");
  const [transferStage, setTransferStage] = React.useState<"pick" | "confirm">("pick");

  const callerRole = session?.role ?? "viewer";
  const isAdmin = callerRole === "owner" || callerRole === "admin";
  const isOwner = callerRole === "owner";

  function submitInvite(event: React.FormEvent): void {
    event.preventDefault();
    invite.mutate(
      { email: inviteEmail.trim(), role: inviteRole },
      {
        onSuccess: () => {
          toast.success(`Invited ${inviteEmail.trim()}`);
          setInviteOpen(false);
          setInviteEmail("");
          setInviteRole("editor");
        },
        onError: (error) =>
          toast.error("Could not send that invitation", { description: messageForError(error) }),
      },
    );
  }

  function startTransfer(membershipId: string): void {
    setTransferTarget(membershipId);
    setTransferStage("pick");
    setConfirmToken("");
    setTransferOpen(true);
  }

  function requestTransfer(): void {
    if (transferTarget === null) return;
    transfer.mutate(
      { toMembershipId: transferTarget },
      {
        onSuccess: (result) => {
          if (result.status === "confirmation_sent") {
            toast.info("Confirmation sent to your email", {
              description: "Enter the code to complete the transfer.",
            });
            setTransferStage("confirm");
          }
        },
        onError: (error) =>
          toast.error("Could not start the transfer", { description: messageForError(error) }),
      },
    );
  }

  function confirmTransfer(): void {
    if (transferTarget === null) return;
    transfer.mutate(
      { toMembershipId: transferTarget, confirmToken: confirmToken.trim() },
      {
        onSuccess: (result) => {
          if (result.status === "transferred") {
            toast.success("Ownership transferred");
            setTransferOpen(false);
          }
        },
        onError: (error) =>
          toast.error("That confirmation did not work", { description: messageForError(error) }),
      },
    );
  }

  const seatsIncluded = entitlement.data?.seatsIncluded ?? 0;
  const seatsUsed = entitlement.data?.seatsUsed ?? 0;
  const billedSeats =
    (entitlement.data?.entitlements["billedSeats"] as number | undefined) ?? seatsIncluded;
  const extraSeatPrice = entitlement.data?.entitlements["extraSeatPrice"] as
    Record<string, number> | null | undefined;
  const perSeat = entitlement.data?.entitlements["perSeat"] === true;

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-8" data-testid="team-page">
      <PageHeader
        title="Team"
        description="Who is in this workspace, what each person can do, and what the seats cost."
        actions={
          isAdmin ? (
            <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
              <DialogTrigger asChild>
                <Button variant="primary" data-testid="invite-member-button">
                  Invite a member
                </Button>
              </DialogTrigger>
              <DialogContent>
                <form onSubmit={submitInvite} className="flex flex-col gap-4">
                  <DialogHeader>
                    <DialogTitle>Invite a member</DialogTitle>
                    <DialogDescription>
                      They will get a link to accept from their own address.
                    </DialogDescription>
                  </DialogHeader>
                  <Field label="Email" htmlFor="invite-email">
                    <Input
                      id="invite-email"
                      type="email"
                      required
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                    />
                  </Field>
                  <Field label="Role" htmlFor="invite-role">
                    <select
                      id="invite-role"
                      className="bg-sunken border-border text-fg-0 h-9 w-full rounded-sm border px-3 text-sm"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
                    >
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
                          {ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <DialogFooter>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={invite.isPending}
                      data-testid="submit-invite"
                    >
                      Send invitation
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : null
        }
      />

      <Card className="flex flex-col gap-2" data-testid="seats-preview">
        <h2 className="text-fg-0 text-base font-semibold">Seats</h2>
        {entitlement.isPending ? (
          <Skeleton className="h-6" />
        ) : (
          <p className="text-fg-2 text-sm">
            {entitlement.data?.planName ?? "Free"} plan · {seatsUsed} active member
            {seatsUsed === 1 ? "" : "s"}
            {perSeat ? ` · billed for ${billedSeats} seat${billedSeats === 1 ? "" : "s"}` : ""}
            {razorpayEnabled && extraSeatPrice?.["INR"] !== undefined
              ? ` · ₹${(extraSeatPrice["INR"] / 100).toFixed(0)} per extra seat / month`
              : ""}
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-0 p-0" data-testid="members-card">
        {members.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : members.isError ? (
          <p className="text-rejected p-4 text-sm" role="alert">
            {messageForError(members.error)}
          </p>
        ) : (members.data ?? []).length === 0 ? (
          <EmptyState
            className="border-0"
            icon={<Users />}
            title="No members yet"
            description={
              isAdmin
                ? "Invite a teammate to edit projects with you."
                : "Ask a workspace admin to invite your teammates."
            }
            {...(isAdmin
              ? {
                  action: (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setInviteOpen(true);
                      }}
                    >
                      Invite your first teammate
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <ul className="divide-border divide-y" data-testid="member-list">
            {(members.data ?? []).map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                canManage={isAdmin && member.role !== "owner"}
                canTransferTo={isOwner && member.role !== "owner" && member.status === "active"}
                onChangeRole={(role) => {
                  changeRole.mutate(
                    { membershipId: member.id, role },
                    {
                      onError: (error) =>
                        toast.error("Could not change that role", {
                          description: messageForError(error),
                        }),
                    },
                  );
                }}
                onRemove={() => {
                  remove.mutate(member.id, {
                    onError: (error) =>
                      toast.error("Could not remove that member", {
                        description: messageForError(error),
                      }),
                  });
                }}
                onTransfer={() => startTransfer(member.id)}
              />
            ))}
          </ul>
        )}
      </Card>

      {(clientTags.data ?? []).length > 0 ? (
        <Card className="flex flex-col gap-3" data-testid="client-tags-card">
          <h2 className="text-fg-0 text-base font-semibold">Client tags</h2>
          <ul className="flex flex-wrap gap-2">
            {(clientTags.data ?? []).map((tag) => (
              <li key={tag.tag}>
                <Badge tone="neutral">
                  {tag.tag} · {tag.projectCount} project{tag.projectCount === 1 ? "" : "s"}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer ownership</DialogTitle>
            <DialogDescription>
              {transferStage === "pick"
                ? "We will email you a confirmation code before anything changes."
                : "Enter the code we just emailed you to finish the transfer."}
            </DialogDescription>
          </DialogHeader>
          {transferStage === "confirm" ? (
            <Field label="Confirmation code" htmlFor="confirm-token">
              <Input
                id="confirm-token"
                value={confirmToken}
                onChange={(e) => setConfirmToken(e.target.value)}
              />
            </Field>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setTransferOpen(false);
              }}
            >
              Keep ownership
            </Button>
            {transferStage === "pick" ? (
              <Button
                variant="primary"
                onClick={requestTransfer}
                disabled={transfer.isPending}
                data-testid="request-transfer"
              >
                Send confirmation
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={confirmTransfer}
                disabled={transfer.isPending}
                data-testid="confirm-transfer"
              >
                Confirm transfer
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function MemberRow({
  member,
  canManage,
  canTransferTo,
  onChangeRole,
  onRemove,
  onTransfer,
}: {
  member: MemberView;
  canManage: boolean;
  canTransferTo: boolean;
  onChangeRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
  onTransfer: () => void;
}): React.JSX.Element {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4"
      data-testid={`member-${member.id}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-fg-0 flex flex-wrap items-center gap-2 text-sm font-medium">
          {member.name ?? member.email ?? "Pending"}
          {member.status === "invited" ? <Badge tone="warning">Invited</Badge> : null}
        </p>
        <p className="text-fg-2 truncate text-xs">{member.email}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <select
            aria-label={`Role for ${member.email ?? "member"}`}
            className="bg-sunken border-border text-fg-0 h-8 rounded-sm border px-2 text-sm"
            value={member.role}
            onChange={(e) => onChangeRole(e.target.value as WorkspaceRole)}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
                {ROLE_LABEL[role]}
              </option>
            ))}
          </select>
        ) : (
          <Badge tone="neutral">{ROLE_LABEL[member.role]}</Badge>
        )}
        {canTransferTo ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onTransfer}
            data-testid={`transfer-to-${member.id}`}
          >
            Make owner
          </Button>
        ) : null}
        {canManage ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={`Remove ${member.name ?? member.email ?? "member"}`}
            data-testid={`remove-${member.id}`}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </li>
  );
}

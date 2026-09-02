import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { validateTaxProfile } from "./tax-profile.js";
import { WORKSPACE_ERRORS } from "./workspaces.constants.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import { A05_AUDIT_ACTIONS, AuditService } from "../users/audit.service.js";
import {
  DEFAULT_BILLING_COUNTRY,
  DEFAULT_REGION,
  personalWorkspaceSlug,
} from "../users/users.service.js";

import type {
  CreateWorkspaceDto,
  TaxProfileDto,
  UpdateWorkspaceDto,
  WorkspaceSettings,
} from "./workspaces.dto.js";
import type { RequestContextInfo } from "../users/profile.service.js";
import type { $Enums, Prisma } from "@prisma/client";

/** Subscription states that lock the currency (04 §Tax): anything not finished. */
const LIVE_SUBSCRIPTION_STATES: readonly $Enums.SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "paused",
];

const WORKSPACE_SELECT = {
  id: true,
  slug: true,
  name: true,
  type: true,
  ownerId: true,
  region: true,
  currency: true,
  billingCountry: true,
  billingCountryConfirmedAt: true,
  billingStateCode: true,
  gstin: true,
  gstinVerifiedAt: true,
  legalName: true,
  settings: true,
  retentionDays: true,
  createdAt: true,
} as const;

type WorkspaceRow = Prisma.WorkspaceGetPayload<{ select: typeof WORKSPACE_SELECT }>;

export interface WorkspaceView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly type: $Enums.WorkspaceType;
  readonly ownerId: string;
  readonly region: $Enums.Region;
  readonly currency: $Enums.Currency;
  readonly billingCountry: string;
  readonly billingCountryConfirmedAt: string | null;
  readonly billingStateCode: string | null;
  readonly gstin: string | null;
  readonly gstinVerifiedAt: string | null;
  readonly legalName: string | null;
  readonly settings: WorkspaceSettings;
  readonly retentionDays: number;
  readonly createdAt: string;
  readonly role: $Enums.MembershipRole;
  readonly memberCount: number;
  readonly currencyLocked: boolean;
}

/**
 * Workspaces: the tenant every project, job, credit and invoice hangs from.
 *
 * A person's **personal** workspace is created by sign-up (A04) and is the one
 * they always have; `POST /workspaces` makes the team and agency ones. Nothing
 * here reads a workspace id from a header or a body — `WorkspaceMemberGuard` has
 * already established that the id in the path is the token's `ws` claim.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every live workspace the caller is an active member of, oldest first. */
  async listForUser(userId: string): Promise<WorkspaceView[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: "active", workspace: { deletedAt: null } },
      orderBy: { createdAt: "asc" },
      select: { role: true, workspace: { select: WORKSPACE_SELECT } },
    });
    if (memberships.length === 0) return [];

    const counts = await this.memberCounts(memberships.map((entry) => entry.workspace.id));
    const locked = await this.lockedWorkspaces(memberships.map((entry) => entry.workspace.id));

    return memberships.map((entry) =>
      toWorkspaceView(
        entry.workspace,
        entry.role,
        counts.get(entry.workspace.id) ?? 1,
        locked.has(entry.workspace.id),
      ),
    );
  }

  /** One workspace. The guard has already proved the caller is a member. */
  async get(workspaceId: string, role: $Enums.MembershipRole): Promise<WorkspaceView> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: WORKSPACE_SELECT,
    });
    if (workspace === null) throw notFound();

    const [counts, locked] = await Promise.all([
      this.memberCounts([workspaceId]),
      this.lockedWorkspaces([workspaceId]),
    ]);
    return toWorkspaceView(workspace, role, counts.get(workspaceId) ?? 1, locked.has(workspaceId));
  }

  /**
   * Create a team or agency workspace, owned by the caller.
   *
   * Region, currency and billing country are inherited from the creator's
   * declared jurisdiction, exactly as sign-up does, and the country is left
   * **unconfirmed**: it is a guess until somebody puts a tax profile on it.
   */
  async create(
    userId: string,
    body: CreateWorkspaceDto,
    context: RequestContextInfo,
  ): Promise<WorkspaceView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, jurisdiction: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null) {
      throw new AppException(ERROR_CODES.notFound, "No such account.", HttpStatus.NOT_FOUND);
    }

    const slug = body.slug ?? personalWorkspaceSlug(body.name);
    await this.assertSlugFree(slug);

    const workspaceId = ulid();
    const billingCountry = DEFAULT_BILLING_COUNTRY[user.jurisdiction];
    const created = await this.prisma.withTransaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          id: workspaceId,
          slug,
          name: body.name,
          type: body.type ?? "team",
          ownerId: userId,
          region: DEFAULT_REGION[user.jurisdiction],
          currency: billingCountry === "IN" ? "INR" : "USD",
          billingCountry,
          billingCountryConfirmedAt: null,
        },
        select: WORKSPACE_SELECT,
      });
      await tx.membership.create({
        data: { id: ulid(), workspaceId, userId, role: "owner", status: "active" },
      });
      return workspace;
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.workspaceCreated,
      resource: "workspace",
      resourceId: workspaceId,
      actorId: userId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { slug, type: created.type },
    });

    return toWorkspaceView(created, "owner", 1, false);
  }

  /** Rename, re-slug or change settings. `PATCH`: absent means "leave alone". */
  async update(
    workspaceId: string,
    actorId: string,
    role: $Enums.MembershipRole,
    body: UpdateWorkspaceDto,
    context: RequestContextInfo,
  ): Promise<WorkspaceView> {
    const before = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: WORKSPACE_SELECT,
    });
    if (before === null) throw notFound();

    if (body.slug !== undefined && body.slug !== before.slug) await this.assertSlugFree(body.slug);

    const data: Prisma.WorkspaceUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.slug !== undefined) data.slug = body.slug;
    if (body.settings !== undefined) {
      // Merge rather than replace: a PATCH that carries one setting must not drop
      // the others, and the column is a single JSONB document.
      data.settings = { ...(before.settings as WorkspaceSettings), ...body.settings };
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data,
      select: WORKSPACE_SELECT,
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.workspaceUpdated,
      resource: "workspace",
      resourceId: workspaceId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { fields: Object.keys(data).sort() },
    });

    const [counts, locked] = await Promise.all([
      this.memberCounts([workspaceId]),
      this.lockedWorkspaces([workspaceId]),
    ]);
    return toWorkspaceView(updated, role, counts.get(workspaceId) ?? 1, locked.has(workspaceId));
  }

  /**
   * The tax profile (D41), and the moment the billing country stops being a guess.
   *
   * `billingCountryConfirmedAt` is stamped here because this is the only place a
   * human states where they are billed; B01 refuses to open a checkout while it is
   * null. The **currency** derived from the country is locked once a subscription
   * exists — changing it mid-subscription would make the next invoice disagree
   * with the mandate that pays it.
   */
  async setTaxProfile(
    workspaceId: string,
    actorId: string,
    role: $Enums.MembershipRole,
    body: TaxProfileDto,
    context: RequestContextInfo,
  ): Promise<WorkspaceView> {
    const before = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: WORKSPACE_SELECT,
    });
    if (before === null) throw notFound();

    const verdict = validateTaxProfile(body);
    if (!verdict.ok) {
      throw new AppException(
        WORKSPACE_ERRORS.taxProfileInvalid,
        verdict.message,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { problem: verdict.problem, ...(verdict.details ?? {}) },
      );
    }
    const profile = verdict.profile;

    const locked = (await this.lockedWorkspaces([workspaceId])).has(workspaceId);
    if (locked && profile.currency !== before.currency) {
      throw new AppException(
        WORKSPACE_ERRORS.taxProfileLocked,
        "The billing currency is fixed for the life of a subscription. Cancel it first, or contact support.",
        HttpStatus.CONFLICT,
        { currency: before.currency, requestedCurrency: profile.currency },
      );
    }

    const now = new Date();
    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        billingCountry: profile.billingCountry,
        billingCountryConfirmedAt: now,
        billingStateCode: profile.billingStateCode,
        gstin: profile.gstin,
        // A GSTIN is only *verified* once the GSTN API confirms it (B01 owns that
        // call); accepting a well-formed number is not the same as verifying it.
        gstinVerifiedAt: profile.gstin === before.gstin ? before.gstinVerifiedAt : null,
        legalName: profile.legalName,
        currency: profile.currency,
        region: profile.region,
      },
      select: WORKSPACE_SELECT,
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.taxProfileUpdated,
      resource: "workspace",
      resourceId: workspaceId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: {
        before: {
          billingCountry: before.billingCountry,
          billingStateCode: before.billingStateCode,
          currency: before.currency,
          gstin: before.gstin,
        },
        after: {
          billingCountry: profile.billingCountry,
          billingStateCode: profile.billingStateCode,
          currency: profile.currency,
          gstin: profile.gstin,
        },
      },
    });

    const counts = await this.memberCounts([workspaceId]);
    return toWorkspaceView(updated, role, counts.get(workspaceId) ?? 1, locked);
  }

  /**
   * Soft-delete a workspace.
   *
   * A personal workspace that is the owner's **only** workspace cannot go: the
   * account would be left with nowhere to work, and every sign-in mints a token
   * scoped to a workspace. `DELETE /me` is how a person leaves altogether.
   */
  async remove(
    workspaceId: string,
    actorId: string,
    context: RequestContextInfo,
  ): Promise<{ id: string; deletedAt: string }> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, type: true, ownerId: true, slug: true },
    });
    if (workspace === null) throw notFound();

    const remaining = await this.prisma.membership.count({
      where: {
        userId: actorId,
        status: "active",
        workspaceId: { not: workspaceId },
        workspace: { deletedAt: null },
      },
    });
    if (remaining === 0) {
      throw new AppException(
        WORKSPACE_ERRORS.lastRemaining,
        "This is your only workspace. Create another one first, or delete your account.",
        HttpStatus.CONFLICT,
        { workspaceId, type: workspace.type },
      );
    }

    const now = new Date();
    await this.prisma.withTransaction(async (tx) => {
      await tx.workspace.update({ where: { id: workspaceId }, data: { deletedAt: now } });
      // Sessions carry the workspace in their token; a deleted workspace must not
      // keep minting access tokens for itself.
      await tx.session.updateMany({
        where: { workspaceId, revokedAt: null },
        data: { revokedAt: now },
      });
    });

    await this.audit.record({
      action: A05_AUDIT_ACTIONS.workspaceDeleted,
      resource: "workspace",
      resourceId: workspaceId,
      actorId,
      workspaceId,
      ...(context.ip === undefined ? {} : { ip: context.ip }),
      data: { slug: workspace.slug, type: workspace.type },
    });

    return { id: workspaceId, deletedAt: now.toISOString() };
  }

  /** Active members per workspace, for the list and detail views. */
  private async memberCounts(workspaceIds: readonly string[]): Promise<Map<string, number>> {
    if (workspaceIds.length === 0) return new Map();
    const rows = await this.prisma.membership.groupBy({
      by: ["workspaceId"],
      where: { workspaceId: { in: [...workspaceIds] }, status: "active" },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.workspaceId, row._count._all]));
  }

  /**
   * Which of these workspaces have a live subscription.
   *
   * Nothing creates a subscription before B01 (the seed's demo workspace aside),
   * so this is the no-op check the brief describes — but it is written against the
   * real table so that B01 turns it on by inserting a row, not by editing this.
   */
  private async lockedWorkspaces(workspaceIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (workspaceIds.length === 0) return new Set();
    const rows = await this.prisma.subscription.findMany({
      where: {
        workspaceId: { in: [...workspaceIds] },
        status: { in: [...LIVE_SUBSCRIPTION_STATES] },
      },
      select: { workspaceId: true },
      distinct: ["workspaceId"],
    });
    return new Set(rows.map((row) => row.workspaceId));
  }

  private async assertSlugFree(slug: string): Promise<void> {
    const existing = await this.prisma.workspace.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing !== null) {
      throw new AppException(
        WORKSPACE_ERRORS.slugTaken,
        "That workspace address is already in use.",
        HttpStatus.CONFLICT,
        { slug },
      );
    }
  }
}

export function toWorkspaceView(
  workspace: WorkspaceRow,
  role: $Enums.MembershipRole,
  memberCount: number,
  currencyLocked: boolean,
): WorkspaceView {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    type: workspace.type,
    ownerId: workspace.ownerId,
    region: workspace.region,
    currency: workspace.currency,
    billingCountry: workspace.billingCountry,
    billingCountryConfirmedAt: workspace.billingCountryConfirmedAt?.toISOString() ?? null,
    billingStateCode: workspace.billingStateCode,
    gstin: workspace.gstin,
    gstinVerifiedAt: workspace.gstinVerifiedAt?.toISOString() ?? null,
    legalName: workspace.legalName,
    settings: (workspace.settings ?? {}) as WorkspaceSettings,
    retentionDays: workspace.retentionDays,
    createdAt: workspace.createdAt.toISOString(),
    role,
    memberCount,
    currencyLocked,
  };
}

function notFound(): AppException {
  return new AppException(WORKSPACE_ERRORS.notFound, "No such workspace.", HttpStatus.NOT_FOUND);
}

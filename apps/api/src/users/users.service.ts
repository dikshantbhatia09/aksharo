import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../common/index.js";

import type { $Enums, Prisma } from "@prisma/client";

/**
 * Which billing country a brand-new personal workspace starts with.
 *
 * Sign-up asks for a jurisdiction (the age gate needs it, D60) but not for a
 * billing address, and `workspaces.billing_country` is NOT NULL. These defaults
 * are placeholders that A05 lets the owner correct in workspace settings; nothing
 * bills from them, because B01 requires the tax profile to be confirmed before an
 * order is created (D41).
 */
export const DEFAULT_BILLING_COUNTRY: Readonly<Record<$Enums.Jurisdiction, string>> = {
  IN: "IN",
  EU: "DE",
  OTHER: "US",
};

/** Data residency (THREAT-MODEL T24): the workspace region follows the jurisdiction. */
export const DEFAULT_REGION: Readonly<Record<$Enums.Jurisdiction, $Enums.Region>> = {
  IN: "in",
  EU: "eu",
  OTHER: "us",
};

const DEFAULT_CURRENCY: Readonly<Record<$Enums.Jurisdiction, $Enums.Currency>> = {
  IN: "INR",
  EU: "USD",
  OTHER: "USD",
};

export interface CreateUserInput {
  readonly email: string;
  readonly name?: string;
  readonly locale?: string;
  readonly passwordHash?: string;
  readonly dateOfBirth: Date;
  readonly jurisdiction: $Enums.Jurisdiction;
  readonly ageBracket: $Enums.AgeBracket;
  readonly emailVerified?: boolean;
  /** Per-purpose consent captured on the sign-up form; all default to false. */
  readonly consents?: ConsentChoices;
  readonly ip?: string;
  readonly ua?: string;
  /** Privacy-notice version the choices were made against (DPDP, 05 section 8). */
  readonly noticeVersion?: string;
}

export interface ConsentChoices {
  readonly analytics?: boolean;
  readonly memory?: boolean;
  readonly marketing?: boolean;
}

export interface CreatedUser {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: $Enums.MembershipRole;
}

/** The version string stamped onto `consent_records`. Bumped when the notice changes. */
export const PRIVACY_NOTICE_VERSION = "2026-09-01";

/** The purposes sign-up can capture. `share_upload` and `affiliate` come later. */
export const SIGNUP_CONSENT_PURPOSES = ["analytics", "memory", "marketing"] as const;

/** A workspace slug from an email local part: lowercase, hyphenated, suffixed. */
export function personalWorkspaceSlug(email: string): string {
  const local = (email.split("@")[0] ?? "user").toLowerCase();
  const base = local.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = base === "" ? "workspace" : base.slice(0, 24);
  return `${stem}-${randomBytes(4).toString("hex")}`;
}

/**
 * Users and their personal workspaces.
 *
 * A04 needs exactly three things from this module: create an account, find one by
 * email, and answer "is this user a member of that workspace, and as what". A05
 * owns the rest (profiles, invitations, workspace settings, the tax profile), so
 * nothing else lives here.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Case-insensitive: addresses are stored lowercased, so this is exact. */
  findByEmail(email: string): Promise<any> {
    return this.prisma.user.findUnique({
      where: { email: normaliseEmail(email) },
      select: {
        id: true,
        email: true,
        name: true,
        // A25: the transactional mail is rendered in the recipient's language,
        // and this is the only lookup the auth flows do before sending one.
        locale: true,
        passwordHash: true,
        emailVerifiedAt: true,
        jurisdiction: true,
        ageBracket: true,
        deletedAt: true,
      },
    });
  }

  /**
   * Create the user, a personal workspace, the owner membership and the consent
   * records, in one transaction: a user without a workspace has nowhere to work,
   * and a consent record written outside the transaction could outlive a rolled
   * back sign-up.
   */
  async createWithPersonalWorkspace(input: CreateUserInput): Promise<CreatedUser> {
    const email = normaliseEmail(input.email);
    const userId = ulid();
    const workspaceId = ulid();
    const now = new Date();

    return this.prisma.withTransaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          email,
          name: input.name ?? null,
          locale: input.locale ?? "en-IN",
          passwordHash: input.passwordHash ?? null,
          dateOfBirth: input.dateOfBirth,
          jurisdiction: input.jurisdiction,
          ageBracket: input.ageBracket,
          emailVerifiedAt: input.emailVerified === true ? now : null,
          marketingOptIn: input.consents?.marketing === true,
          analyticsConsentAt: input.consents?.analytics === true ? now : null,
          memoryConsentAt: input.consents?.memory === true ? now : null,
        },
      });

      await tx.workspace.create({
        data: {
          id: workspaceId,
          slug: personalWorkspaceSlug(email),
          name: input.name === undefined ? "My workspace" : `${input.name}'s workspace`,
          type: "personal",
          ownerId: userId,
          region: DEFAULT_REGION[input.jurisdiction],
          currency: DEFAULT_CURRENCY[input.jurisdiction],
          billingCountry: DEFAULT_BILLING_COUNTRY[input.jurisdiction],
        },
      });

      await tx.membership.create({
        data: {
          id: ulid(),
          workspaceId,
          userId,
          role: "owner",
          status: "active",
        },
      });

      await tx.consentRecord.createMany({
        data: consentRows({
          userId,
          workspaceId,
          choices: input.consents ?? {},
          at: now,
          ...(input.ip === undefined ? {} : { ip: input.ip }),
          ...(input.ua === undefined ? {} : { ua: input.ua }),
          noticeVersion: input.noticeVersion ?? PRIVACY_NOTICE_VERSION,
        }),
      });

      return { userId, workspaceId, role: "owner" as const };
    });
  }

  /** The caller's active membership in a workspace, or `null`. */
  membership(userId: string, workspaceId: string): Promise<any> {
    return this.prisma.membership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, status: true, workspaceId: true },
    });
  }

  /** The workspace a sign-in defaults to: the personal one, else the oldest. */
  async defaultWorkspace(
    userId: string,
  ): Promise<{ workspaceId: string; role: $Enums.MembershipRole } | null> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: "active", workspace: { deletedAt: null } },
      orderBy: { createdAt: "asc" },
      select: { workspaceId: true, role: true, workspace: { select: { type: true } } },
    });
    const personal = memberships.find((entry) => entry.workspace.type === "personal");
    const chosen = personal ?? memberships[0];
    return chosen === undefined ? null : { workspaceId: chosen.workspaceId, role: chosen.role };
  }

  markEmailVerified(userId: string): Promise<any> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
      select: { id: true },
    });
  }

  setPasswordHash(userId: string, passwordHash: string): Promise<any> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
      select: { id: true },
    });
  }

  touchLastSeen(userId: string): Promise<any> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date() },
      select: { id: true },
    });
  }
}

/** Addresses are compared and stored lowercased; nothing else is normalised. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * One `consent_records` row per purpose, granted or not.
 *
 * A refusal is recorded as a row with `granted: false` rather than as an absent
 * row: the DPDP notice-and-choice record has to show what was asked as well as
 * what was agreed.
 */
export function consentRows(input: {
  userId: string;
  workspaceId: string;
  choices: ConsentChoices;
  at: Date;
  ip?: string;
  ua?: string;
  noticeVersion: string;
}): Prisma.ConsentRecordCreateManyInput[] {
  return SIGNUP_CONSENT_PURPOSES.map((purpose) => ({
    id: ulid(),
    userId: input.userId,
    workspaceId: input.workspaceId,
    purpose,
    version: input.noticeVersion,
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    granted: input.choices[purpose] === true,
    grantedAt: input.at,
    ip: input.ip ?? null,
    ua: input.ua ?? null,
    noticeVersion: input.noticeVersion,
  }));
}

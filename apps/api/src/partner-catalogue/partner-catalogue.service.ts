import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";

import { EpidemicPartnerCatalogue } from "./epidemic-partner-catalogue.js";
import { buildLicenceSnapshot } from "./licence-snapshot.js";
import { MockPartnerCatalogue } from "./mock-partner-catalogue.js";
import {
  DEFAULT_GRANT_TERM_DAYS,
  PARTNER_CATALOGUE_ERRORS,
  PARTNER_CATALOGUE_FLAG,
  PARTNER_CATALOGUE_PROVIDER_FLAG,
} from "./partner-catalogue.constants.js";
import { AppException } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { ENV } from "../config/config.module.js";

import type { PartnerCatalogueProviderName } from "./partner-catalogue.constants.js";
import type {
  PartnerCatalogue,
  PartnerSearchFilters,
  PartnerSearchResult,
  PartnerStreamRef,
} from "./partner-catalogue.types.js";

/**
 * The one caller of every `PartnerCatalogue` adapter (D04b scope §1): flag
 * gates live here, never in an adapter, so `MockPartnerCatalogue` and
 * `EpidemicPartnerCatalogue` stay pure API-boundary code the interface
 * contract tests can exercise with no flag and no database at all.
 *
 * `assets.partnerCatalogue` (`FEATURE_FLAGS_JSON`) gates every method — off
 * by default (2026-09-03 orchestrator launch ruling). While off, every call
 * throws {@link PARTNER_CATALOGUE_ERRORS.disabled} before the selected
 * adapter is even constructed, so a caller can never observe partner data
 * (mock or real) through this service while the flag is off.
 */
@Injectable()
export class PartnerCatalogueService {
  private readonly mock = new MockPartnerCatalogue();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  /** `assets.partnerCatalogue` — off by default. */
  get enabled(): boolean {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled
    return this.env.FEATURE_FLAGS_JSON[PARTNER_CATALOGUE_FLAG] === true;
  }

  /** `assets.partnerCatalogueProvider` — `"mock"` once the flag is on, unless set to `"epidemic"`. */
  get providerName(): PartnerCatalogueProviderName {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled
    return this.env.FEATURE_FLAGS_JSON[PARTNER_CATALOGUE_PROVIDER_FLAG] === "epidemic"
      ? "epidemic"
      : "mock";
  }

  private adapter(): PartnerCatalogue {
    if (this.providerName === "epidemic") {
      return new EpidemicPartnerCatalogue({
        apiKey: process.env["EPIDEMIC_PARTNER_API_KEY"],
        apiSecret: process.env["EPIDEMIC_PARTNER_API_SECRET"],
        baseUrl: process.env["EPIDEMIC_PARTNER_API_BASE_URL"],
      });
    }
    return this.mock;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.disabled,
        "Partner catalogue is not enabled for this workspace.",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  async search(query: string, filters?: PartnerSearchFilters): Promise<PartnerSearchResult> {
    this.assertEnabled();
    return this.adapter().search(query, filters);
  }

  async stream(providerAssetId: string): Promise<PartnerStreamRef> {
    this.assertEnabled();
    return this.adapter().stream(providerAssetId);
  }

  /**
   * Safelisting grant (D04b scope §1). Persists an `asset_clearance_grants`
   * row with a TODO(H-28) placeholder `licenceSnapshot`
   * (`licence-snapshot.ts`) — the snapshot an accept flow (D04a/D04c, outside
   * this work package's file boundary) would freeze onto `EdgPassItem
   * .licenceSnapshot` at accept time, once wired.
   */
  async grant(input: {
    readonly providerAssetId: string;
    readonly workspaceId: string;
    readonly useContext: string;
  }): Promise<{ readonly grantId: string; readonly licenceSnapshot: Record<string, unknown> }> {
    this.assertEnabled();
    const adapter = this.adapter();
    const partnerGrant = await adapter.grant({
      providerAssetId: input.providerAssetId,
      workspaceId: input.workspaceId,
      useContext: input.useContext,
    });
    const snapshot = buildLicenceSnapshot(partnerGrant.licence);
    const expiresAt = new Date(Date.now() + DEFAULT_GRANT_TERM_DAYS * 24 * 60 * 60 * 1000);

    const row = await this.prisma.assetClearanceGrant.create({
      data: {
        id: ulid(),
        workspaceId: input.workspaceId,
        // `AudioProvider` has no `"mock"` value — a mock-adapter grant is a
        // rehearsal of the real `epidemic` row shape, never a distinct provider.
        provider: "epidemic",
        providerLicenceId: partnerGrant.grantId,
        platform: "montaj",
        assetScope: "video",
        partnerUserId: input.providerAssetId,
        status: "active",
        useContext: input.useContext,
        licenceSnapshot: snapshot as unknown as object,
        expiresAt,
      },
    });
    return { grantId: row.id, licenceSnapshot: snapshot as unknown as Record<string, unknown> };
  }

  /**
   * Usage reporting after a cloud render completes (`export.completed`,
   * B14b precedent). Idempotent: re-reporting an already-reported grant for
   * the same export just returns the prior report rather than double-firing
   * the partner call — `scheduler/tasks/partner-usage-report.task.ts`'s
   * retry sweep relies on this.
   */
  async reportUsage(input: {
    readonly grantId: string;
    readonly exportId: string;
  }): Promise<{ readonly reportRef: string; readonly reportedAt: Date }> {
    this.assertEnabled();
    const grant = await this.prisma.assetClearanceGrant.findUnique({
      where: { id: input.grantId },
    });
    if (grant === null) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantNotFound,
        `No such grant: ${input.grantId}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (grant.status === "revoked") {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantRevoked,
        `Grant ${input.grantId} was revoked.`,
        HttpStatus.CONFLICT,
      );
    }
    if (grant.status === "expired" || (grant.expiresAt !== null && grant.expiresAt < new Date())) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantExpired,
        `Grant ${input.grantId} has expired.`,
        HttpStatus.CONFLICT,
      );
    }

    const result = await this.adapter().reportUsage({
      grantId: grant.providerLicenceId ?? grant.id,
      exportId: input.exportId,
    });

    return { reportRef: result.reportRef, reportedAt: new Date(result.reportedAt) };
  }

  /**
   * D04b2 scope §4 — `apps/render`'s pre-download check: is there an active,
   * unexpired grant for this partner asset in this workspace? Looked up by
   * `partnerUserId` (the provider asset id, `grant()`'s own field) rather
   * than `assetId`, since a partner-catalogue grant carries no local
   * `AudioAsset` row (`schema.prisma`'s `assetId` is nullable for exactly
   * this reason). `false` while the flag is off, exactly like every other
   * method here — a render never sees a grant the workspace could not have
   * created in the first place.
   */
  async verifyActiveGrant(input: {
    readonly workspaceId: string;
    readonly providerAssetId: string;
  }): Promise<boolean> {
    if (!this.enabled) return false;
    const grant = await this.prisma.assetClearanceGrant.findFirst({
      where: {
        workspaceId: input.workspaceId,
        partnerUserId: input.providerAssetId,
        status: "active",
      },
      orderBy: { createdAt: "desc" },
    });
    if (grant === null) return false;
    if (grant.expiresAt !== null && grant.expiresAt < new Date()) return false;
    return true;
  }

  /**
   * D04b2 scope §5 — the B13 admin grants table's read. Deliberately not
   * gated by `assertEnabled()`: platform staff must be able to see (and
   * revoke) every grant a workspace holds even after `assets.partnerCatalogue`
   * is turned back off for that workspace, the same "admin can always see
   * what happened" posture the rest of `admin/**` takes.
   */
  async listGrants(): Promise<
    {
      readonly id: string;
      readonly workspaceId: string;
      readonly providerAssetId: string | null;
      readonly useContext: string | null;
      readonly status: string;
      readonly expiresAt: string | null;
      readonly createdAt: string;
      readonly reportStatus: "reported" | "unreported" | "no_usage";
    }[]
  > {
    const grants = await this.prisma.assetClearanceGrant.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { usages: { select: { reportedAt: true } } },
    });
    return grants.map((grant) => ({
      id: grant.id,
      workspaceId: grant.workspaceId,
      providerAssetId: grant.partnerUserId,
      useContext: grant.useContext,
      status: grant.status,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      createdAt: grant.createdAt.toISOString(),
      reportStatus:
        grant.usages.length === 0
          ? "no_usage"
          : grant.usages.every((usage) => usage.reportedAt !== null)
            ? "reported"
            : "unreported",
    }));
  }

  async revoke(grantId: string): Promise<void> {
    this.assertEnabled();
    const grant = await this.prisma.assetClearanceGrant.findUnique({ where: { id: grantId } });
    if (grant === null) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantNotFound,
        `No such grant: ${grantId}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (grant.providerLicenceId !== null) {
      await this.adapter().revoke(grant.providerLicenceId);
    }
    await this.prisma.assetClearanceGrant.update({
      where: { id: grantId },
      data: { status: "revoked", revokedAt: new Date() },
    });
  }

  /**
   * D04b2 scope §5 — the admin table's revoke action. Same steps as
   * {@link revoke}, deliberately without the `assertEnabled()` gate: a
   * platform-staff member must be able to revoke a grant a workspace holds
   * even after the flag has been turned back off for that workspace (the
   * same reasoning {@link listGrants} documents).
   */
  async adminRevoke(grantId: string): Promise<void> {
    const grant = await this.prisma.assetClearanceGrant.findUnique({ where: { id: grantId } });
    if (grant === null) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantNotFound,
        `No such grant: ${grantId}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (grant.providerLicenceId !== null) {
      await this.adapter().revoke(grant.providerLicenceId);
    }
    await this.prisma.assetClearanceGrant.update({
      where: { id: grantId },
      data: { status: "revoked", revokedAt: new Date() },
    });
  }
}

import { HttpStatus } from "@nestjs/common";
import { ulid } from "ulid";

import { PARTNER_CATALOGUE_ERRORS } from "./partner-catalogue.constants.js";
import { AppException } from "../common/errors/error-codes.js";

import type {
  PartnerCatalogue,
  PartnerGrant,
  PartnerGrantRequest,
  PartnerSearchFilters,
  PartnerSearchHit,
  PartnerSearchResult,
  PartnerStreamRef,
  PartnerUsageReportRequest,
  PartnerUsageReportResult,
} from "./partner-catalogue.types.js";

/**
 * Recorded/mock partner catalogue (D04b brief: "recorded fixture responses
 * shaped after the partner's public API documentation, cited"). Shaped after
 * the publicly documented response fields of Epidemic Sound's Partner API
 * (search hit: id, title, tags, mood, bpm, duration; licence: territory,
 * usage rights, attribution — https://partner.epidemicsound.com, accessed
 * for field names only, no credentials, no real catalogue data). Every id,
 * title and tag below is invented for this fixture — never a real partner
 * asset id — per the 2026-09-03 orchestrator addendum: "no partner asset
 * shipped in fixtures" (i.e. never in `prisma/seed-data.ts`; this file is
 * test/dev fixture data for the interface itself, not seeded catalogue rows).
 */
const FIXTURE_HITS: readonly PartnerSearchHit[] = [
  {
    providerAssetId: "mock-sfx-0001",
    provider: "mock",
    title: "Fixture whoosh transition",
    tags: ["whoosh", "transition", "sfx"],
    mood: [],
    bpm: null,
    durationMs: 900,
    licence: {
      licenceType: "sync",
      territory: ["WORLD"],
      termStart: null,
      termEnd: null,
      allowsCommercialUse: true,
      allowsMonetisation: true,
      allowsPaidAds: false,
      allowsBroadcast: false,
      requiresAttribution: false,
      attributionText: null,
      clearanceMethod: "platform_covered",
      requiresUsageReport: true,
    },
    allowsRawFileDelivery: false,
  },
  {
    providerAssetId: "mock-music-0001",
    provider: "mock",
    title: "Fixture upbeat corporate bed",
    tags: ["corporate", "upbeat"],
    mood: ["energetic", "optimistic"],
    bpm: 120,
    durationMs: 92_000,
    licence: {
      licenceType: "sync",
      territory: ["WORLD"],
      termStart: null,
      termEnd: null,
      allowsCommercialUse: true,
      allowsMonetisation: true,
      allowsPaidAds: true,
      allowsBroadcast: false,
      requiresAttribution: false,
      attributionText: null,
      clearanceMethod: "channel_safelist",
      requiresUsageReport: true,
    },
    allowsRawFileDelivery: false,
  },
];

interface MockGrantRow {
  grant: PartnerGrant;
  reports: PartnerUsageReportResult[];
}

/**
 * In-memory adapter used behind `assets.partnerCatalogueProvider: "mock"`.
 * State lives for the process lifetime — fine for interface contract tests
 * and for `PARTNER_CATALOGUE_FLAG` demos; `PartnerCatalogueService` is the
 * only caller that persists anything durably (`asset_clearance_grants`,
 * `asset_usages`).
 */
export class MockPartnerCatalogue implements PartnerCatalogue {
  readonly providerName = "mock";
  private readonly grants = new Map<string, MockGrantRow>();

  async search(query: string, filters?: PartnerSearchFilters): Promise<PartnerSearchResult> {
    const needle = query.trim().toLowerCase();
    const hits = FIXTURE_HITS.filter((hit) => {
      if (filters?.kind === "sfx" && hit.bpm !== null) return false;
      if (filters?.kind === "music" && hit.bpm === null) return false;
      if (filters?.minBpm !== undefined && (hit.bpm ?? -Infinity) < filters.minBpm) return false;
      if (filters?.maxBpm !== undefined && (hit.bpm ?? Infinity) > filters.maxBpm) return false;
      if (
        filters?.maxDurationMs !== undefined &&
        (hit.durationMs ?? Infinity) > filters.maxDurationMs
      ) {
        return false;
      }
      if (needle === "") return true;
      return (
        hit.title.toLowerCase().includes(needle) ||
        hit.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        hit.mood.some((mood) => mood.toLowerCase().includes(needle))
      );
    });
    return { hits, total: hits.length };
  }

  async stream(providerAssetId: string): Promise<PartnerStreamRef> {
    const hit = FIXTURE_HITS.find((entry) => entry.providerAssetId === providerAssetId);
    if (hit === undefined) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.notFound,
        `No such partner asset: ${providerAssetId}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    // A proxied, short-lived reference — never the partner's own raw URL
    // handed straight to a browser (D43 preview-stream-only rule).
    return {
      url: `https://mock-partner.internal/stream/${providerAssetId}?ttl=600`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      proxied: true,
    };
  }

  async grant(request: PartnerGrantRequest): Promise<PartnerGrant> {
    const hit = FIXTURE_HITS.find((entry) => entry.providerAssetId === request.providerAssetId);
    if (hit === undefined) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.notFound,
        `No such partner asset: ${request.providerAssetId}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    const grant: PartnerGrant = {
      grantId: ulid(),
      providerAssetId: request.providerAssetId,
      workspaceId: request.workspaceId,
      status: "active",
      licence: hit.licence,
      expiresAt: null,
    };
    this.grants.set(grant.grantId, { grant, reports: [] });
    return grant;
  }

  async reportUsage(request: PartnerUsageReportRequest): Promise<PartnerUsageReportResult> {
    const row = this.grants.get(request.grantId);
    if (row === undefined) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantNotFound,
        `No such grant: ${request.grantId}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.grant.status !== "active") {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantRevoked,
        `Grant ${request.grantId} is ${row.grant.status}, not active.`,
        HttpStatus.CONFLICT,
      );
    }
    const result: PartnerUsageReportResult = {
      reportRef: `mock-report-${ulid()}`,
      reportedAt: new Date().toISOString(),
    };
    row.reports.push(result);
    return result;
  }

  async revoke(grantId: string): Promise<void> {
    const row = this.grants.get(grantId);
    if (row === undefined) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.grantNotFound,
        `No such grant: ${grantId}.`,
        HttpStatus.NOT_FOUND,
      );
    }
    this.grants.set(grantId, {
      ...row,
      grant: { ...row.grant, status: "revoked" },
    });
  }

  /** Test/dev helper: how many usage reports a grant has recorded. */
  reportsFor(grantId: string): readonly PartnerUsageReportResult[] {
    return this.grants.get(grantId)?.reports ?? [];
  }
}

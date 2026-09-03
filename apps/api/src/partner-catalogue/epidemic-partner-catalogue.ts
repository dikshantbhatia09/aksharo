import { HttpStatus } from "@nestjs/common";

import { H28_CONTRACT_GATE_TEXT, PARTNER_CATALOGUE_ERRORS } from "./partner-catalogue.constants.js";
import { AppException } from "../common/errors/error-codes.js";

import type {
  PartnerCatalogue,
  PartnerGrant,
  PartnerGrantRequest,
  PartnerSearchFilters,
  PartnerSearchResult,
  PartnerStreamRef,
  PartnerUsageReportRequest,
  PartnerUsageReportResult,
} from "./partner-catalogue.types.js";

/** `EPIDEMIC_PARTNER_API_KEY`/`EPIDEMIC_PARTNER_API_SECRET` — not in CONTRACTS
 * §1 (that list is frozen and this work package must not edit it): read
 * directly from `process.env` here, exactly like an unconfigured adapter that
 * has nothing to validate against yet. Once H-28 signs and a following work
 * package adds these to the contract, this is the one file that changes. */
export interface EpidemicPartnerCatalogueConfig {
  readonly apiKey?: string;
  readonly apiSecret?: string;
  readonly baseUrl?: string;
}

/**
 * The real adapter skeleton (D04b scope §1). H-28 — the signed Epidemic
 * Sound Partner API contract and its credentials — is still open (human
 * action, `_orchestration/D04b-partner-catalogue.md`). Every method throws
 * {@link PARTNER_CATALOGUE_ERRORS.contractGate} until `isConfigured()` is
 * true, so this class can be wired into `PartnerCatalogueModule` today, ship
 * dark behind `assets.partnerCatalogueProvider: "epidemic"`, and become a
 * thin, separately reviewable file when the contract lands — no caller of
 * `PartnerCatalogue` changes.
 */
export class EpidemicPartnerCatalogue implements PartnerCatalogue {
  readonly providerName = "epidemic";

  constructor(private readonly config: EpidemicPartnerCatalogueConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.apiSecret);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new AppException(
        PARTNER_CATALOGUE_ERRORS.contractGate,
        H28_CONTRACT_GATE_TEXT,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  async search(_query: string, _filters?: PartnerSearchFilters): Promise<PartnerSearchResult> {
    this.assertConfigured();
    // H-28: real search call — Epidemic Sound Partner API — added once the
    // contract and credentials exist. Unreachable while unconfigured.
    throw new AppException(
      PARTNER_CATALOGUE_ERRORS.contractGate,
      H28_CONTRACT_GATE_TEXT,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  async stream(_providerAssetId: string): Promise<PartnerStreamRef> {
    this.assertConfigured();
    throw new AppException(
      PARTNER_CATALOGUE_ERRORS.contractGate,
      H28_CONTRACT_GATE_TEXT,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  async grant(_request: PartnerGrantRequest): Promise<PartnerGrant> {
    this.assertConfigured();
    throw new AppException(
      PARTNER_CATALOGUE_ERRORS.contractGate,
      H28_CONTRACT_GATE_TEXT,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  async reportUsage(_request: PartnerUsageReportRequest): Promise<PartnerUsageReportResult> {
    this.assertConfigured();
    throw new AppException(
      PARTNER_CATALOGUE_ERRORS.contractGate,
      H28_CONTRACT_GATE_TEXT,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  async revoke(_grantId: string): Promise<void> {
    this.assertConfigured();
    throw new AppException(
      PARTNER_CATALOGUE_ERRORS.contractGate,
      H28_CONTRACT_GATE_TEXT,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * D04b — partner catalogue integration (contract-gated).
 *
 * `assets.partnerCatalogue` (`FEATURE_FLAGS_JSON`, CONTRACTS §1): the one
 * switch that gates every partner-catalogue code path — `off` by default per
 * the 2026-09-03 orchestrator launch ruling. `docs/CONTRACTS.md`'s
 * `CONTRACT_ENV_VARS` list is frozen (this work package must not edit it), so
 * this deliberately reuses the existing `FEATURE_FLAGS_JSON` mechanism
 * (`auth/breached-password.service.ts`, `invoices/invoices.service.ts`) rather
 * than adding a new `PARTNER_CATALOGUE` contract variable the brief names —
 * see the final report for this deviation.
 *
 * `assets.partnerCatalogueProvider` selects the adapter behind the interface:
 * `"mock"` (default, once the flag is on) or `"epidemic"` — the real adapter,
 * which throws the H-28 contract-gate error until credentials are configured.
 */
export const PARTNER_CATALOGUE_FLAG = "assets.partnerCatalogue";
export const PARTNER_CATALOGUE_PROVIDER_FLAG = "assets.partnerCatalogueProvider";

export type PartnerCatalogueProviderName = "mock" | "epidemic";

/** Error codes this module raises (`namespace/slug`, CONTRACTS §8). */
export const PARTNER_CATALOGUE_ERRORS = {
  disabled: "partner-catalogue/disabled",
  contractGate: "partner-catalogue/contract_gate",
  notFound: "partner-catalogue/not_found",
  grantNotFound: "partner-catalogue/grant_not_found",
  grantRevoked: "partner-catalogue/grant_revoked",
  grantExpired: "partner-catalogue/grant_expired",
  cloudRenderOnly: "partner-catalogue/cloud_render_only",
} as const;

/**
 * H-28 (`_orchestration/D04b-partner-catalogue.md`): the human action still
 * open — no real partner (e.g. Epidemic Sound) contract is signed and no
 * credentials exist. `EpidemicPartnerCatalogue` throws
 * {@link PARTNER_CATALOGUE_ERRORS.contractGate} with this text until both are
 * configured; nothing else about this work package depends on H-28 closing.
 */
export const H28_CONTRACT_GATE_TEXT =
  "H-28: partner catalogue contract not signed. Needs a signed partner API " +
  "contract (e.g. Epidemic Sound Partner API) and its API credentials " +
  "(EPIDEMIC_PARTNER_API_KEY / EPIDEMIC_PARTNER_API_SECRET) before the " +
  "epidemic adapter can serve a single request. Until then the catalogue " +
  "runs off or mock only.";

/** Default grant term when the partner contract names none yet (TODO(H-28)). */
export const DEFAULT_GRANT_TERM_DAYS = 365;

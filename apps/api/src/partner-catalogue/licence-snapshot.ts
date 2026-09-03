import type { PartnerLicenceTerms } from "./partner-catalogue.types.js";

/**
 * TODO(H-28): every value this module writes is a placeholder. H-28 (the
 * signed partner contract) is the human action that names the real licence
 * terms — territory, permitted uses, attribution, the clearance method a
 * partner actually offers. Until it closes, `licenceSnapshot` rows carry this
 * shape with `pending: true` and a `licenceType` tag that says so, so a
 * downstream reader (an audit, a support ticket, a later migration) can find
 * every placeholder with one query (`licenceSnapshot->>'licenceType' = 'TODO(H-28)'`)
 * rather than guessing which rows are real. The orchestrator addendum
 * (2026-09-03) is explicit: "when H-28 closes, the only change should be data
 * + flag" — this function is the one place that data changes.
 */
export const TODO_H28_LICENCE_TYPE = "TODO(H-28)";

/** The `LicenceSnapshotSchema`-shaped placeholder written until H-28 signs. */
export interface LicenceSnapshot extends PartnerLicenceTerms {
  readonly pending: true;
  readonly note: string;
}

/**
 * Builds the placeholder licence snapshot for a partner grant. `terms` is
 * whatever the adapter (mock or real) reported; every field is passed
 * through so the *shape* the eventual real snapshot will have is exercised
 * end to end today, but `licenceType`/`pending`/`note` always mark it as not
 * yet real.
 */
export function buildLicenceSnapshot(terms: PartnerLicenceTerms): LicenceSnapshot {
  return {
    ...terms,
    licenceType: TODO_H28_LICENCE_TYPE,
    pending: true,
    note:
      "Placeholder licence terms — H-28 (partner contract) is not signed. " +
      "Do not rely on these values for a real clearance decision.",
  };
}

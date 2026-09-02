/** Codes this module adds to the CONTRACTS §8 namespaces (07 §Styles, fonts, templates, memory). */
export const MEMORY_ERRORS = {
  /** No active, un-withdrawn `memory` consent for the caller (D62). */
  consentRequired: "memory/consent_required",
  notFound: "memory/not_found",
  importInvalid: "memory/import_invalid",
} as const;

export type MemoryErrorCode = (typeof MEMORY_ERRORS)[keyof typeof MEMORY_ERRORS];

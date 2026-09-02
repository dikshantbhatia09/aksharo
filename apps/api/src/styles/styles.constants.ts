import type { RateLimitRule } from "../common/guards/index.js";

/**
 * Error codes and rate rules for `/styles` and `/workspaces/{id}/style-presets`
 * (CONTRACTS §8: every code is `namespace/slug`).
 */
export const STYLE_ERRORS = {
  notFound: "style/not_found",
  keyTaken: "style/key_taken",
  /** The submitted `doc.id` names a system style; a workspace may not shadow it. */
  reservedKey: "style/reserved_key",
  /** `PATCH` tried to change `doc.id` — that is a new style, not an edit. */
  keyImmutable: "style/key_immutable",
} as const;

/** Creating and editing presets: generous, but not a scripting loop. */
export const STYLE_RATE_LIMITS = {
  writePreset: {
    name: "styles:write:user",
    by: "user",
    capacity: 60,
    refillPerSec: 60 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;

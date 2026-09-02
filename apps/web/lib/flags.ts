/**
 * `FEATURE_FLAGS_JSON` (CONTRACTS §1), parsed.
 *
 * Its own module rather than part of `runtime-config.ts`, because that one is
 * marked `server-only` and this is pure data the client and the tests both read.
 */
export function parseFlags(raw: string | null): Record<string, boolean> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const flags: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") flags[key] = value;
    }
    return flags;
  } catch {
    return {};
  }
}

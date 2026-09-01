import denylist from "./naming/denylist.json";

/**
 * The style naming rule (decision D64).
 *
 * > Styles describe the look, never a person, creator or brand: "Hormozi Pop"
 * > becomes `punch-pop`, a MrBeast-style becomes `hype-bold`, and no name mirrors
 * > a competitor's.
 *
 * The deny-list is data (`src/naming/denylist.json`) so the catalogue admin can
 * extend it without a code change; `StyleDocSchema` runs this on every parse, and
 * `/styles` runs it again before an admin saves a name.
 */

/** Tokens shorter than this are only matched as whole words, never as substrings. */
const SUBSTRING_MIN_LENGTH = 5;

export interface Denylist {
  version: number;
  rule: string;
  maintainer: string;
  tokens: string[];
}

/** The deny-list as committed. */
export const DENYLIST: Denylist = denylist;

/** Just the tokens, lowercased. */
export const DENYLIST_TOKENS: readonly string[] = denylist.tokens.map((token) =>
  token.toLowerCase(),
);

export interface NamingViolation {
  /** Which field broke the rule. */
  field: "id" | "name";
  /** The deny-list token that matched. */
  token: string;
  /** `word` when the token is the whole word, `substring` when it sits inside one. */
  match: "word" | "substring";
}

/** Splits a name or id into comparable lowercase words. */
export function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function violationsFor(
  field: "id" | "name",
  value: string,
  tokens: readonly string[],
): NamingViolation[] {
  const words = nameTokens(value);
  const found: NamingViolation[] = [];
  for (const denied of tokens) {
    if (words.includes(denied)) {
      found.push({ field, token: denied, match: "word" });
      continue;
    }
    if (denied.length >= SUBSTRING_MIN_LENGTH && words.some((word) => word.includes(denied))) {
      found.push({ field, token: denied, match: "substring" });
    }
  }
  return found;
}

/** Every deny-list hit in a style's `id` and `name`; empty means the name is allowed. */
export function findNamingViolations(
  style: { id?: unknown; name?: unknown },
  tokens: readonly string[] = DENYLIST_TOKENS,
): NamingViolation[] {
  const violations: NamingViolation[] = [];
  if (typeof style.id === "string") violations.push(...violationsFor("id", style.id, tokens));
  if (typeof style.name === "string") violations.push(...violationsFor("name", style.name, tokens));
  return violations;
}

/** `true` when nothing in the id or name is on the deny-list. */
export function isCompliantStyleName(
  style: { id?: unknown; name?: unknown },
  tokens: readonly string[] = DENYLIST_TOKENS,
): boolean {
  return findNamingViolations(style, tokens).length === 0;
}

/** Thrown by `assertCompliantStyleName`. */
export class StyleNamingError extends Error {
  override readonly name = "StyleNamingError";
  constructor(readonly violations: NamingViolation[]) {
    super(
      `style name breaks the no-person/no-brand rule (D64): ${violations
        .map((violation) => `${violation.field} contains "${violation.token}"`)
        .join("; ")}`,
    );
  }
}

/** Throws `StyleNamingError` unless the id and name are allowed. */
export function assertCompliantStyleName(
  style: { id?: unknown; name?: unknown },
  tokens: readonly string[] = DENYLIST_TOKENS,
): void {
  const violations = findNamingViolations(style, tokens);
  if (violations.length > 0) throw new StyleNamingError(violations);
}

import { generateMogrtDefinition } from "./generate.js";
import { MOGRT_PARAM_NAMES } from "./params.js";
import { MogrtDefinitionSchema, type MogrtDefinition } from "./schema.js";
import { readZip, ZipParseError } from "./zip.js";

/**
 * Verifies a `.mogrt` zip: unzips it, parses `definition.json`, checks it
 * against the schema and against the frozen param table, and confirms an
 * `.aep` is present unless the file is explicitly a placeholder.
 *
 * Used by (a) CI, against the committed `mogrt/placeholder.mogrt`, and (b) is
 * the function C06's Premiere panel start-up self-test should import and run
 * against the real shipped `.mogrt` before trusting `setMogrtParams` — see
 * `docs/MOGRT-PARAMS.md` for the wiring note (C06 had not landed when this was
 * written, so the actual call site does not exist yet in this worktree).
 */

export type VerifyIssueKind =
  | "not-a-zip"
  | "missing-definition"
  | "invalid-json"
  | "schema-invalid"
  | "param-count-mismatch"
  | "param-mismatch"
  | "missing-aep"
  | "unexpected-aep-on-placeholder"
  | "multiple-aep";

export interface VerifyIssue {
  kind: VerifyIssueKind;
  message: string;
  /** Present for `param-mismatch`: the param name and index involved. */
  paramName?: string;
  paramIndex?: number;
}

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
  definition?: MogrtDefinition;
  isPlaceholder: boolean;
}

export interface VerifyOptions {
  /** Allow a `.mogrt` with no `.aep` and `definition.placeholder === true`. Default false. */
  allowPlaceholder?: boolean;
}

export function verifyMogrtBuffer(buffer: Buffer, options: VerifyOptions = {}): VerifyResult {
  const issues: VerifyIssue[] = [];

  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    const message = error instanceof ZipParseError ? error.message : String(error);
    return { ok: false, issues: [{ kind: "not-a-zip", message }], isPlaceholder: false };
  }

  const definitionEntry = entries.find((entry) => entry.name === "definition.json");
  if (!definitionEntry) {
    issues.push({ kind: "missing-definition", message: "no definition.json entry in the zip" });
    return { ok: false, issues, isPlaceholder: false };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(definitionEntry.data.toString("utf8"));
  } catch (error) {
    issues.push({
      kind: "invalid-json",
      message: `definition.json is not valid JSON: ${(error as Error).message}`,
    });
    return { ok: false, issues, isPlaceholder: false };
  }

  const parsed = MogrtDefinitionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    issues.push({ kind: "schema-invalid", message: parsed.error.message });
    return { ok: false, issues, isPlaceholder: false };
  }

  const definition = parsed.data;
  const isPlaceholder = definition.placeholder === true;

  // Param order/name/displayName/type/index check against the frozen table,
  // reported by name and index as the brief requires.
  const canonical = generateMogrtDefinition({ placeholder: isPlaceholder }).params;
  if (definition.params.length !== canonical.length) {
    issues.push({
      kind: "param-count-mismatch",
      message: `expected ${canonical.length} params (${MOGRT_PARAM_NAMES.join(", ")}), found ${definition.params.length}`,
    });
  }
  const max = Math.max(definition.params.length, canonical.length);
  for (let i = 0; i < max; i++) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const actual = definition.params[i];
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const expected = canonical[i];
    if (!expected) {
      issues.push({
        kind: "param-mismatch",
        message: `param at index ${i} ("${actual?.name}") is not in the frozen table`,
        paramIndex: i,
        paramName: actual?.name,
      });
      continue;
    }
    if (!actual) {
      issues.push({
        kind: "param-mismatch",
        message: `missing param "${expected.name}" at index ${i}`,
        paramIndex: i,
        paramName: expected.name,
      });
      continue;
    }
    if (
      actual.name !== expected.name ||
      actual.displayName !== expected.displayName ||
      actual.type !== expected.type
    ) {
      issues.push({
        kind: "param-mismatch",
        message:
          `param at index ${i}: expected name="${expected.name}" displayName="${expected.displayName}" type="${expected.type}", ` +
          `got name="${actual.name}" displayName="${actual.displayName}" type="${actual.type}"`,
        paramIndex: i,
        paramName: actual.name,
      });
    }
  }

  const aepEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".aep"));
  if (aepEntries.length > 1) {
    issues.push({
      kind: "multiple-aep",
      message: `expected at most one .aep, found ${aepEntries.length}`,
    });
  }
  if (aepEntries.length === 0) {
    if (!isPlaceholder || !options.allowPlaceholder) {
      issues.push({
        kind: "missing-aep",
        message: isPlaceholder
          ? "this is a placeholder .mogrt (no .aep) but allowPlaceholder was not set"
          : "no .aep found in the zip and definition.placeholder is not true",
      });
    }
  } else if (isPlaceholder) {
    issues.push({
      kind: "unexpected-aep-on-placeholder",
      message: "definition.placeholder is true but a .aep is present",
    });
  }

  return { ok: issues.length === 0, issues, definition, isPlaceholder };
}

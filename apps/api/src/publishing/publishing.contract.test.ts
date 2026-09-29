import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PUBLISH_ERROR_BEHAVIOUR,
  PUBLISH_ERROR_CODES,
  PUBLISH_PROVIDERS,
  PublishDispatchPayloadSchema,
  PublishReconcilePayloadSchema,
  publishDispatchJobKey,
  publishReconcileJobKey,
} from "./publishing.contract.js";

/**
 * `publishing.contract.ts` restates `@montaj/publishing-contracts` rather than
 * importing it (its header says why). This reads the contract's own source and
 * fails the moment the two drift, so the restatement cannot quietly go stale.
 */
const CONTRACT = readFileSync(
  join(__dirname, "../../../../packages/publishing-contracts/src/schema.ts"),
  "utf8",
);

/** The quoted names in one `export const X = [ ... ] as const;` block of the contract. */
function listIn(pattern: RegExp, name: string): string[] {
  const block = pattern.exec(CONTRACT)?.[1];
  if (block === undefined) throw new Error(`${name} not found in the contract`);
  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

const PROVIDERS = /export const PUBLISH_PROVIDERS = \[([\s\S]*?)\] as const;/;
const ERROR_CODES = /export const PUBLISH_ERROR_CODES = \[([\s\S]*?)\] as const;/;

describe("publishing contract parity", () => {
  it("names the same providers, in the same order", () => {
    expect([...PUBLISH_PROVIDERS]).toEqual(listIn(PROVIDERS, "PUBLISH_PROVIDERS"));
  });

  it("names the same error codes, and gives each the contract's behaviour", () => {
    expect([...PUBLISH_ERROR_CODES]).toEqual(listIn(ERROR_CODES, "PUBLISH_ERROR_CODES"));
    const behaviours =
      /PUBLISH_ERROR_BEHAVIOUR = Object\.freeze\(\{([\s\S]*?)\}/.exec(CONTRACT)?.[1] ?? "";
    for (const [code, behaviour] of Object.entries(PUBLISH_ERROR_BEHAVIOUR)) {
      expect(behaviours, code).toContain(`"${code}": "${behaviour}"`);
    }
  });

  it("builds the contract's job keys", () => {
    expect(CONTRACT).toContain("return `publish.dispatch:${targetId}:${String(attemptNo)}`;");
    expect(CONTRACT).toContain("return `publish.reconcile:${targetId}`;");
    expect(publishDispatchJobKey("01JCTARGET0000000000000000", 2)).toBe(
      "publish.dispatch:01JCTARGET0000000000000000:2",
    );
    expect(publishReconcileJobKey("01JCTARGET0000000000000000")).toBe(
      "publish.reconcile:01JCTARGET0000000000000000",
    );
  });

  it("parses the contract's own dispatch and reconcile payload fixtures", () => {
    const fixtures = join(__dirname, "../../../../packages/publishing-contracts/fixtures");
    const dispatch = JSON.parse(
      readFileSync(join(fixtures, "dispatch-payload.v1.json"), "utf8"),
    ) as unknown;
    expect(PublishDispatchPayloadSchema.safeParse(dispatch).success).toBe(true);
    expect(
      PublishReconcilePayloadSchema.safeParse({
        schemaVersion: 1,
        publishTargetId: "01JCTARGET0000000000000000",
        checkNo: 3,
      }).success,
    ).toBe(true);
    // One id and a number, nothing else: copy never rides in Redis.
    expect(
      PublishDispatchPayloadSchema.safeParse({ ...(dispatch as object), copy: "hello" }).success,
    ).toBe(false);
  });
});

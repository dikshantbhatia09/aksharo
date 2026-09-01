import { readFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  JSON_SCHEMA_FILENAMES,
  readCommittedSchemaFile,
  renderSchemaFiles,
} from "../../scripts/schema-files.js";
import { createUlidFactory } from "../ids.js";
import {
  buildEdgJsonSchema,
  buildEdgOpsJsonSchema,
  EDG_OPS_SCHEMA_ID,
  EDG_SCHEMA_ID,
} from "./json-schema.js";

const FIXTURES = join(__dirname, "..", "..", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

/** `strict: false` keeps Ajv quiet about the `title`/`description` annotations Zod emits. */
function ajv(): Ajv2020 {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
}

describe("committed JSON Schemas", () => {
  it("are up to date with the Zod schemas", async () => {
    const rendered = await renderSchemaFiles();
    for (const fileName of JSON_SCHEMA_FILENAMES) {
      const committed = await readCommittedSchemaFile(fileName);
      expect(
        committed,
        `schemas/${fileName} is missing — run "pnpm --filter @montaj/edg schemas:build"`,
      ).toBeDefined();
      expect(
        committed,
        `schemas/${fileName} is stale — run "pnpm --filter @montaj/edg schemas:build"`,
      ).toBe(rendered[fileName]);
    }
  });

  it("carry brand-free URN ids", () => {
    expect(buildEdgJsonSchema()["$id"]).toBe(EDG_SCHEMA_ID);
    expect(buildEdgOpsJsonSchema()["$id"]).toBe(EDG_OPS_SCHEMA_ID);
    for (const fileName of JSON_SCHEMA_FILENAMES) {
      const raw = readFileSync(join(__dirname, "..", "..", "schemas", fileName), "utf8");
      expect(raw).not.toMatch(/aksharo|montaj\.ai/i);
    }
  });
});

describe("edg-v2.json", () => {
  const validate = ajv().compile(buildEdgJsonSchema());

  it("validates the sample project", () => {
    expect(validate(fixture("sample-project.json"))).toBe(true);
  });

  it("rejects a document with the wrong schema version", () => {
    const broken = fixture("sample-project.json") as { meta: { schemaVersion: number } };
    broken.meta.schemaVersion = 1;
    expect(validate(broken)).toBe(false);
  });

  it("rejects an unknown property", () => {
    const broken = fixture("sample-project.json") as Record<string, unknown>;
    broken["extra"] = true;
    expect(validate(broken)).toBe(false);
  });

  it("rejects a pass item whose payload does not match its kind", () => {
    const broken = fixture("sample-project.json") as {
      passes: { items: { payload: Record<string, unknown> }[] }[];
    };
    const zoom = broken.passes[1]?.items[0];
    if (zoom !== undefined)
      zoom.payload = { assetId: "01JBZ9F8Q0000000000000000A", gainDb: 0, offsetMs: 0 };
    expect(validate(broken)).toBe(false);
  });
});

describe("edg-ops-v2.json", () => {
  const document = buildEdgOpsJsonSchema();
  const validateOp = ajv().compile(document);
  const newId = createUlidFactory({
    now: () => 1_766_000_000_000,
    randomDigits: () => new Array(16).fill(9),
  });

  it("validates a single op at the root", () => {
    expect(validateOp({ opId: newId(), type: "DeleteWord", wordId: "0:11" })).toBe(true);
    expect(validateOp({ opId: newId(), type: "DeleteWord", wordId: "eleven" })).toBe(false);
  });

  it("exposes the batch envelopes as $defs", () => {
    const defs = document["$defs"] as Record<string, unknown>;
    expect(Object.keys(defs)).toEqual(
      expect.arrayContaining([
        "EdgOp",
        "OpBatchRequest",
        "OpBatchResponse",
        "OpConflict",
        "EdgOpsEvent",
      ]),
    );
  });

  it("validates a batch request through its $def", () => {
    const validateBatch = ajv().compile({ ...document, $ref: "#/$defs/OpBatchRequest" });
    const opId = newId();
    expect(
      validateBatch({
        baseRevision: 4,
        ops: [{ opId, type: "HideSegment", segmentId: newId(), hidden: true }],
        clientOpIds: [opId],
      }),
    ).toBe(true);
  });
});

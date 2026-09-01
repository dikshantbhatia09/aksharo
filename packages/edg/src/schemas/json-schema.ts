import { z } from "zod";

import { EdgProjectionSchema } from "./document.js";
import {
  EdgOpSchema,
  EdgOpsEventSchema,
  OpBatchRequestSchema,
  OpBatchResponseSchema,
  OpConflictSchema,
} from "./ops.js";

/**
 * JSON Schema emission for the two committed documents under `schemas/`.
 *
 * Zod 4 emits JSON Schema natively (`z.toJSONSchema`), so no `zod-to-json-schema`
 * dependency is needed — that package targets Zod 3 and would be a second source
 * of truth. Every schema carrying an `id` in its `.meta()` is lifted into `$defs`
 * and referenced, which keeps the documents small and readable.
 */

/** The draft these documents are written against. */
export const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Schema ids are URNs on the engineering codename, not `https://montaj.ai/…` as
 * sketched in `07 §EDG JSON schema`: CONTRACTS §0 forbids the codename in any
 * domain, and the brand domain belongs in `packages/config/src/brand.ts` alone.
 */
export const EDG_SCHEMA_ID = "urn:montaj:schema:edg-v2";
export const EDG_OPS_SCHEMA_ID = "urn:montaj:schema:edg-ops-v2";

/** File name → document, as committed under `packages/edg/schemas/`. */
export const JSON_SCHEMA_FILENAMES = ["edg-v2.json", "edg-ops-v2.json"] as const;

export type JsonSchemaFileName = (typeof JSON_SCHEMA_FILENAMES)[number];

type JsonSchemaDocument = Record<string, unknown>;

function toDocument(schema: z.ZodType): JsonSchemaDocument {
  // `io: "output"` is the wire shape; no schema in this package uses a default or
  // a transform, so the input and output shapes are identical either way.
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  }) as unknown as JsonSchemaDocument;
}

/** The EDG document schema: a full projection (hot state + segments + passes). */
export function buildEdgJsonSchema(): JsonSchemaDocument {
  const generated = toDocument(EdgProjectionSchema);
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: EDG_SCHEMA_ID,
    title: "EDG v2",
    description:
      "Edit Decision Graph v2, storage-independent view (05 §4, 07 §EDG JSON schema). Generated from @montaj/edg; do not edit by hand.",
    $ref: generated["$ref"],
    $defs: generated["$defs"],
  };
}

/**
 * The op schema: `EdgOp` at the root, with the batch request/response, the 409
 * conflict body and the realtime event available as `$defs`.
 */
export function buildEdgOpsJsonSchema(): JsonSchemaDocument {
  // A wrapper only exists so one conversion sees every root at once and emits a
  // single, cross-referenced `$defs` block; it is never part of the output.
  const bundle = z.object({
    op: EdgOpSchema,
    batchRequest: OpBatchRequestSchema,
    batchResponse: OpBatchResponseSchema,
    conflict: OpConflictSchema,
    event: EdgOpsEventSchema,
  });
  const generated = toDocument(bundle);
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: EDG_OPS_SCHEMA_ID,
    title: "EDG ops v2",
    description:
      "Semantic EDG ops and the op-batch envelopes (D29, CONTRACTS §2). The root validates one EdgOp; the batch types are under $defs. Generated from @montaj/edg; do not edit by hand.",
    $ref: "#/$defs/EdgOp",
    $defs: generated["$defs"],
  };
}

/** Both committed documents, keyed by file name. */
export function buildJsonSchemaDocuments(): Record<JsonSchemaFileName, JsonSchemaDocument> {
  return {
    "edg-v2.json": buildEdgJsonSchema(),
    "edg-ops-v2.json": buildEdgOpsJsonSchema(),
  };
}

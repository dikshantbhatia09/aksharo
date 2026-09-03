import { readFile } from "node:fs/promises";
import { join } from "node:path";

import prettier from "prettier";

import {
  buildJsonSchemaDocuments,
  JSON_SCHEMA_FILENAMES,
  type JsonSchemaFileName,
} from "../src/schemas/json-schema.js";

/**
 * One renderer for the committed JSON Schemas, shared by the generator script
 * and the "schemas are up to date" test, so the two can never disagree about
 * formatting.
 */

/** Where the generated documents live. */
export const SCHEMAS_DIR = join(__dirname, "..", "schemas");

/** Absolute path of one committed document. */
export function schemaFilePath(fileName: JsonSchemaFileName): string {
  return join(SCHEMAS_DIR, fileName);
}

/** The document as it must appear on disk: Prettier-formatted, LF, trailing newline. */
export async function renderSchemaFile(fileName: JsonSchemaFileName): Promise<string> {
  const filePath = schemaFilePath(fileName);
  const documents = buildJsonSchemaDocuments();
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const json = JSON.stringify(documents[fileName], null, 2);
  const options = await prettier.resolveConfig(filePath, { editorconfig: false });
  return prettier.format(json, { ...options, filepath: filePath, parser: "json" });
}

/** Every document, keyed by file name. */
export async function renderSchemaFiles(): Promise<Record<JsonSchemaFileName, string>> {
  const entries = await Promise.all(
    JSON_SCHEMA_FILENAMES.map(
      async (fileName) => [fileName, await renderSchemaFile(fileName)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<JsonSchemaFileName, string>;
}

/** The committed document, or `undefined` when it has never been generated. */
export async function readCommittedSchemaFile(
  fileName: JsonSchemaFileName,
): Promise<string | undefined> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    return await readFile(schemaFilePath(fileName), "utf8");
  } catch {
    return undefined;
  }
}

export { JSON_SCHEMA_FILENAMES, type JsonSchemaFileName };

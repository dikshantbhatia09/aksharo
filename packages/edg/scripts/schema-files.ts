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
    return await readFile(schemaFilePath(fileName), "utf8");
  } catch {
    return undefined;
  }
}

export { JSON_SCHEMA_FILENAMES, type JsonSchemaFileName };

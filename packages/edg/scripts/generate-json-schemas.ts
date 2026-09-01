import { mkdir, writeFile } from "node:fs/promises";

import {
  readCommittedSchemaFile,
  renderSchemaFiles,
  SCHEMAS_DIR,
  schemaFilePath,
} from "./schema-files.js";

/**
 * Regenerates `packages/edg/schemas/*.json` from the Zod schemas. Wired into the
 * package `build`, and guarded by `src/schemas/json-schema.test.ts` so a stale
 * commit fails CI.
 */
async function main(): Promise<void> {
  await mkdir(SCHEMAS_DIR, { recursive: true });
  const rendered = await renderSchemaFiles();
  for (const [fileName, content] of Object.entries(rendered)) {
    const path = schemaFilePath(fileName as keyof typeof rendered);
    const previous = await readCommittedSchemaFile(fileName as keyof typeof rendered);
    if (previous === content) {
      console.log(`schemas: ${fileName} unchanged`);
      continue;
    }
    await writeFile(path, content, "utf8");
    console.log(`schemas: wrote ${fileName}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

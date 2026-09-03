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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  await mkdir(SCHEMAS_DIR, { recursive: true });
  const rendered = await renderSchemaFiles();
  for (const [fileName, content] of Object.entries(rendered)) {
    const path = schemaFilePath(fileName as keyof typeof rendered);
    const previous = await readCommittedSchemaFile(fileName as keyof typeof rendered);
    if (previous === content) {
      console.log(`schemas: ${fileName} unchanged`);
      continue;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await writeFile(path, content, "utf8");
    console.log(`schemas: wrote ${fileName}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

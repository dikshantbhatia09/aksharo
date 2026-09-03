import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateMogrtDefinition } from "./generate.js";
import { writeZipStore } from "./zip.js";

/**
 * Builds `mogrt/placeholder.mogrt`: a zip with the generated `definition.json`
 * and a clearly-marked placeholder note, no `.aep` and no other assets. This is
 * what CI's `verify:mogrt` step checks (`allowPlaceholder: true`) and stands in
 * for the real MOGRT until a human authors the `.aep` (H-25).
 *
 * Run with: `pnpm --filter @montaj/premiere-uxp generate:mogrt-placeholder`
 */

const PLACEHOLDER_NOTE = `This is a PLACEHOLDER Aksharo caption .mogrt.

It contains a generated definition.json (param order/names/types/defaults) and
this note, and deliberately contains NO After Effects project (.aep) and no
assets. It exists so mogrt/verify.ts and CI can exercise the zip-unpack and
schema-check path before a human authors the real .aep in After Effects.

See plugins/premiere-uxp/docs/README-AUTHORING.md for the authoring steps and
plugins/premiere-uxp/docs/MOGRT-PARAMS.md for the frozen param table.
`;

export function buildPlaceholderMogrt(): Buffer {
  const definition = generateMogrtDefinition({ placeholder: true });
  const definitionJson = Buffer.from(JSON.stringify(definition, null, 2) + "\n", "utf8");
  const note = Buffer.from(PLACEHOLDER_NOTE, "utf8");

  return writeZipStore([
    { name: "definition.json", data: definitionJson },
    { name: "PLACEHOLDER.txt", data: note },
  ]);
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, "placeholder.mogrt");
  writeFileSync(outPath, buildPlaceholderMogrt());
  console.error(`wrote ${outPath}`);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

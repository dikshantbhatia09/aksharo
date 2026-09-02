import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyMogrtBuffer } from "./verify.js";

/**
 * CI entry point: verifies the committed placeholder `.mogrt`. Wired into
 * `.github/workflows/ci.yml` as a standalone step so a broken generator/schema
 * (or a hand-edited placeholder that drifted from the frozen params) fails the
 * build the same way a real `.mogrt` mismatch would fail C06's start-up
 * self-test.
 *
 * Run with: `pnpm --filter @montaj/premiere-uxp verify:mogrt`
 */

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "placeholder.mogrt");
  const buffer = readFileSync(path);
  const result = verifyMogrtBuffer(buffer, { allowPlaceholder: true });

  if (result.ok) {
    console.error(
      `OK: ${path} verifies (${result.definition?.params.length} params, placeholder=${result.isPlaceholder})`,
    );
    process.exit(0);
  }

  console.error(`FAIL: ${path} does not verify:`);
  for (const issue of result.issues) {
    console.error(`  [${issue.kind}] ${issue.message}`);
  }
  process.exit(1);
}

main();

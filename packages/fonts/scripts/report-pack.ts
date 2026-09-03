/**
 * Print the catalogue table the WP report and the README both carry, against
 * the pack actually on disk rather than against `src/catalogue.ts`'s claims —
 * so a stale README is a diff, not a trap.
 *
 * ```
 * pnpm --filter @montaj/fonts pack:report
 * ```
 */

import { summariseFamilies } from "../src/manifest.js";
import { bundledPackDirectory, readPackManifest } from "../src/pack.js";
import { REQUIRED_SCRIPTS, SCRIPT_NAMES, type ScriptTag } from "../src/scripts.js";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  const directory = bundledPackDirectory();
  const manifest = await readPackManifest(directory);
  const families = summariseFamilies(manifest);

  const widths = {
    family: Math.max(6, ...families.map((f) => f.family.length)),
    weights: Math.max(7, ...families.map((f) => f.weights.join(", ").length)),
    scripts: Math.max(
      7,
      ...families.map(
        (f) => f.scriptTags.map((tag) => SCRIPT_NAMES[tag as ScriptTag] ?? tag).join(", ").length,
      ),
    ),
    licence: 9,
  };

  process.stdout.write(`\nfont pack at ${directory}\n\n`);
  process.stdout.write(
    `${pad("Family", widths.family)}  ${pad("Weights", widths.weights)}  ` +
      `${pad("Scripts", widths.scripts)}  ${pad("Licence", widths.licence)}  Size\n`,
  );
  process.stdout.write(
    `${"-".repeat(widths.family + widths.weights + widths.scripts + widths.licence + 14)}\n`,
  );

  let totalTtf = 0;
  let totalWoff2 = 0;
  for (const family of families) {
    const scriptNames = family.scriptTags
      .map((tag) => SCRIPT_NAMES[tag as ScriptTag] ?? tag)
      .join(", ");
    const woff2Bytes = family.faces.reduce((sum, face) => sum + (face.woff2SizeBytes ?? 0), 0);
    totalTtf += family.totalBytes;
    totalWoff2 += woff2Bytes;
    process.stdout.write(
      `${pad(family.family, widths.family)}  ${pad(family.weights.join(", "), widths.weights)}  ` +
        `${pad(scriptNames, widths.scripts)}  ${pad(family.licence ?? "?", widths.licence)}  ` +
        `${(family.totalBytes / 1024).toFixed(0)} kB ttf / ${(woff2Bytes / 1024).toFixed(0)} kB woff2\n`,
    );
  }

  process.stdout.write(
    `\n${String(families.length)} families, ${String(manifest.fonts.length)} faces, ` +
      `${(totalTtf / 1024 / 1024).toFixed(2)} MB ttf + ${(totalWoff2 / 1024 / 1024).toFixed(2)} MB woff2\n`,
  );

  const covered = new Set(families.flatMap((family) => family.scriptTags));
  const missing = REQUIRED_SCRIPTS.filter((tag) => !covered.has(tag));
  if (missing.length > 0) {
    process.stdout.write(
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      `\nMISSING required scripts: ${missing.map((tag) => `${tag} (${SCRIPT_NAMES[tag]})`).join(", ")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `\nEvery required script (the 22 scheduled languages + Latin) is covered.\n`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

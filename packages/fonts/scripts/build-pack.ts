/**
 * Build the bundled font pack.
 *
 * ```
 * pnpm --filter @montaj/fonts pack:build            # rebuild from the lock
 * pnpm --filter @montaj/fonts pack:build -- --update-lock   # re-pin digests
 * ```
 *
 * For every family in `src/catalogue.ts` it downloads the pinned upstream file
 * from `google/fonts`, checks it against `sources.lock.json`, instances the
 * variable axes, subsets to the family's scripts, writes a `.ttf` and a `.woff2`
 * per face, copies the licence text, and finally writes `pack/fonts.json` — the
 * manifest the render node reads through `RENDER_FONT_DIR` and the API serves at
 * `GET /fonts/manifest`.
 *
 * The downloads are cached in `.cache/` (gitignored), so a rebuild after an
 * edit to the catalogue costs seconds. The lockfile is what makes the build
 * reproducible: a pinned commit plus a SHA-256 per file means "the same pack"
 * is a checkable claim rather than a hope about a mirror.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CATALOGUE,
  CATALOGUE_UPSTREAM_REF,
  CATALOGUE_UPSTREAM_REPO,
  catalogueSources,
  faceFileName,
  faceId,
  sourceFileFor,
  upstreamPath,
  upstreamUrl,
  type CatalogueFamily,
} from "../src/catalogue.js";
import { LICENCE_DIR, MANIFEST_FILE, type FontFace, type FontManifest } from "../src/manifest.js";
import { coverageRatio, COVERAGE_THRESHOLD, toWordScripts } from "../src/scripts.js";
import { subsetFace } from "../src/subset.js";
import { validateFont } from "../src/validate.js";

const PACKAGE_ROOT = join(__dirname, "..");
const PACK_DIR = join(PACKAGE_ROOT, "pack");
const CACHE_DIR = join(PACKAGE_ROOT, ".cache");
const LOCK_FILE = join(PACKAGE_ROOT, "sources.lock.json");

interface LockEntry {
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

type Lock = Record<string, LockEntry>;

const updateLock = process.argv.includes("--update-lock");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readLock(): Promise<Lock> {
  if (!existsSync(LOCK_FILE)) return {};
  return JSON.parse(await readFile(LOCK_FILE, "utf8")) as Lock;
}

/** Download one upstream file, using the cache and checking the lock. */
async function fetchSource(key: string, url: string, lock: Lock): Promise<Uint8Array> {
  const cached = join(CACHE_DIR, key.replace(/[\\/]/g, "__"));
  let bytes: Uint8Array | undefined;
  if (existsSync(cached)) bytes = new Uint8Array(await readFile(cached));

  if (bytes === undefined) {
    process.stdout.write(`  fetching ${key}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cached, bytes);
  }

  const sha256 = digest(bytes);
  const pinned = lock[key];
  if (pinned === undefined) {
    if (!updateLock) {
      throw new Error(
        `${key} is not in sources.lock.json; re-run with --update-lock to pin it (${sha256})`,
      );
    }
    lock[key] = { url, sha256, sizeBytes: bytes.byteLength };
  } else if (pinned.sha256 !== sha256) {
    if (!updateLock) {
      throw new Error(
        `${key} hashes to ${sha256} but the lock says ${pinned.sha256}; the upstream moved`,
      );
    }
    lock[key] = { url, sha256, sizeBytes: bytes.byteLength };
  }
  return bytes;
}

async function buildFamily(
  family: CatalogueFamily,
  lock: Lock,
): Promise<{ faces: FontFace[]; licenceBytes: string }> {
  const faces: FontFace[] = [];
  const licenceKey = `${family.directory}/${family.upstreamLicenceFile}`;
  const licence = await fetchSource(
    licenceKey,
    upstreamUrl(family, family.upstreamLicenceFile),
    lock,
  );

  for (const face of family.faces) {
    const sourceFile = sourceFileFor(family, face);
    const key = `${family.directory}/${sourceFile}`;
    const source = await fetchSource(key, upstreamUrl(family, sourceFile), lock);

    const { sfnt, woff2 } = await subsetFace(source, {
      scripts: family.scripts,
      ...(face.axes === undefined ? {} : { axes: face.axes }),
    });

    // The pack is the thing renderers trust, so the built face goes through the
    // same validator an upload does — a subset that lost a script is a bug in
    // the axis pin or the range table, and it must not reach the manifest.
    const validation = validateFont(sfnt);
    for (const script of family.scripts) {
      const ratio = coverageRatio(script, validation.codePoints);
      if (ratio < COVERAGE_THRESHOLD) {
        throw new Error(
          `${family.family} ${String(face.weight)} covers only ${(ratio * 100).toFixed(0)}% of ${script} after subsetting`,
        );
      }
    }
    if (validation.variable) {
      throw new Error(
        `${family.family} ${String(face.weight)} still has variation axes (${validation.variationAxes.join(", ")}) after instancing`,
      );
    }

    const italic = face.italic ?? false;
    const ttfName = faceFileName(family.family, face.weight, italic, "ttf");
    const woff2Name = faceFileName(family.family, face.weight, italic, "woff2");
    await writeFile(join(PACK_DIR, ttfName), sfnt);
    await writeFile(join(PACK_DIR, woff2Name), woff2);

    faces.push({
      id: faceId(family.family, face.weight, italic),
      family: family.family,
      weight: face.weight,
      italic,
      file: ttfName,
      scripts: toWordScripts(family.scripts),
      scriptTags: [...family.scripts],
      woff2: woff2Name,
      sizeBytes: sfnt.byteLength,
      woff2SizeBytes: woff2.byteLength,
      sha256: digest(sfnt),
      licence: family.licence,
      licenceFile: family.licenceFile,
      upstream: {
        repo: CATALOGUE_UPSTREAM_REPO,
        ref: CATALOGUE_UPSTREAM_REF,
        path: upstreamPath(family, sourceFile),
      },
    });
    process.stdout.write(
      `  ${family.family} ${String(face.weight)}: ${(sfnt.byteLength / 1024).toFixed(0)} kB ttf, ${(woff2.byteLength / 1024).toFixed(0)} kB woff2\n`,
    );
  }

  return { faces, licenceBytes: Buffer.from(licence).toString("utf8") };
}

async function main(): Promise<void> {
  const lock = await readLock();
  await rm(PACK_DIR, { recursive: true, force: true });
  await mkdir(join(PACK_DIR, LICENCE_DIR), { recursive: true });

  process.stdout.write(
    `building the font pack from ${CATALOGUE_UPSTREAM_REPO}@${CATALOGUE_UPSTREAM_REF.slice(0, 10)} ` +
      `(${String(CATALOGUE.length)} families, ${String(catalogueSources().length)} upstream files)\n`,
  );

  const fonts: FontFace[] = [];
  for (const family of CATALOGUE) {
    const { faces, licenceBytes } = await buildFamily(family, lock);
    fonts.push(...faces);
    await writeFile(join(PACK_DIR, LICENCE_DIR, family.licenceFile), licenceBytes, "utf8");
  }

  const manifest: FontManifest = {
    v: 1,
    origin: "bundled",
    generatedAt: new Date().toISOString(),
    fonts,
  };
  await writeFile(join(PACK_DIR, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(LOCK_FILE, `${JSON.stringify(sortLock(lock), null, 2)}\n`, "utf8");

  const ttfBytes = fonts.reduce((sum, face) => sum + face.sizeBytes, 0);
  const woff2Bytes = fonts.reduce((sum, face) => sum + (face.woff2SizeBytes ?? 0), 0);
  process.stdout.write(
    `wrote ${String(fonts.length)} faces: ${(ttfBytes / 1024 / 1024).toFixed(2)} MB ttf + ` +
      `${(woff2Bytes / 1024 / 1024).toFixed(2)} MB woff2 into ${PACK_DIR}\n`,
  );
}

function sortLock(lock: Lock): Lock {
  return Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

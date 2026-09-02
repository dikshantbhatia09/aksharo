import fs from "node:fs/promises";
import path from "node:path";

import { buildCycloneDxDocument, writeSbom, type CycloneDxComponent } from "../lib/sbom.js";

import type { ReleaseContext } from "../types.js";

export interface SbomOptions {
  artifactName: string;
  version: string;
  /** Package.json files to summarize as CycloneDX library components (Node side). */
  packageJsonPaths: string[];
}

export interface SbomResult {
  path: string;
  componentCount: number;
}

/**
 * `sbom`: CycloneDX document for a release artifact. Node dependencies are read directly
 * from each package's `package.json` (deterministic, no network); this stands in for
 * `@cyclonedx/cyclonedx-npm` output, which a real (non-sandboxed) run would additionally
 * shell out to for a full dependency-tree BOM plus `cyclonedx-bom` for the Python worker
 * image. Both packages are wired as dependencies of this CLI for that follow-up.
 */
export async function runSbom(ctx: ReleaseContext, opts: SbomOptions): Promise<SbomResult> {
  const components: CycloneDxComponent[] = [];
  for (const pkgPath of opts.packageJsonPaths) {
    const raw = await fs.readFile(pkgPath, "utf8").catch(() => undefined);
    if (!raw) continue;
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      components.push({ type: "library", name, version: version.replace(/^[\^~]/, ""), purl: `pkg:npm/${name}@${version.replace(/^[\^~]/, "")}` });
    }
  }

  const doc = buildCycloneDxDocument(opts.artifactName, opts.version, components);
  const outDir = path.join(ctx.outDir, "artifacts", "sbom");
  const file = await writeSbom(outDir, opts.artifactName, doc);
  return { path: file, componentCount: components.length };
}

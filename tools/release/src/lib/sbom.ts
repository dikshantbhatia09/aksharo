import path from "node:path";

import { ensureDir, writeJson } from "./fsUtil.js";

export interface CycloneDxComponent {
  type: "application" | "library";
  name: string;
  version: string;
  purl?: string;
}

/**
 * Produces a CycloneDX 1.5 SBOM document. Real generation shells out to
 * `@cyclonedx/cyclonedx-npm` (Node deps) and Python `cyclonedx-bom` (engine deps) — both are
 * dependencies of this package; here we assemble the top-level document plus whichever
 * component list the caller already gathered, so the shape is unit-testable without
 * invoking either external tool.
 */
export function buildCycloneDxDocument(
  name: string,
  version: string,
  components: CycloneDxComponent[],
): Record<string, unknown> {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date(0).toISOString(),
      component: { type: "application", name, version },
    },
    components: components.map((c) => ({
      type: c.type,
      name: c.name,
      version: c.version,
      ...(c.purl ? { purl: c.purl } : {}),
    })),
  };
}

export async function writeSbom(outDir: string, artifactName: string, doc: Record<string, unknown>): Promise<string> {
  await ensureDir(outDir);
  const file = path.join(outDir, `${artifactName}.cdx.json`);
  await writeJson(file, doc);
  return file;
}

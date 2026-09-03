import fs from "node:fs";
import path from "node:path";

import "server-only";

import type { PluginGuide } from "./schema";

/**
 * `plugins/<slug>/README.md` -> guide pages (brief §2). Read from the monorepo
 * root rather than `apps/web/content/**` — the README is each plugin's own,
 * already-maintained source of truth (C05a/C05b/C08's own doc), and copying
 * it into `content/docs` would create a second copy that drifts. `fs.existsSync`
 * on the four known plugin directories (rather than `readdirSync` the whole
 * `plugins/` tree) keeps this generator from accidentally publishing an
 * unfinished/internal plugin package that happens to sit next to these four.
 */
const REPO_ROOT = path.join(process.cwd(), "..", "..");

const PLUGIN_SOURCES: readonly {
  readonly slug: string;
  readonly dir: string;
  readonly title: string;
}[] = [
  { slug: "premiere", dir: "premiere-uxp", title: "Premiere Pro" },
  { slug: "after-effects", dir: "ae-cep", title: "After Effects" },
  { slug: "resolve", dir: "resolve", title: "DaVinci Resolve" },
  { slug: "resolve-panel", dir: "resolve-panel", title: "DaVinci Resolve panel" },
];

let cache: readonly PluginGuide[] | undefined;

/** First `# Heading` line of the README, or the configured title if absent. */
function titleFromReadme(body: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(body);
  return match?.[1]?.trim() ?? fallback;
}

export function loadPluginGuides(): readonly PluginGuide[] {
  if (!cache) {
    cache = PLUGIN_SOURCES.flatMap(({ slug, dir, title }) => {
      const sourcePath = path.join("plugins", dir, "README.md");
      const absolutePath = path.join(REPO_ROOT, sourcePath);
      if (!fs.existsSync(absolutePath)) return [];
      const raw = fs.readFileSync(absolutePath, "utf8");
      return [
        {
          slug,
          title: titleFromReadme(raw, title),
          sourcePath: sourcePath.replaceAll("\\", "/"),
          body: raw.trim(),
        },
      ];
    });
  }
  return cache;
}

export function getPluginGuide(slug: string): PluginGuide | undefined {
  return loadPluginGuides().find((guide) => guide.slug === slug);
}

/** Test-only: clears the module cache so a test can point `process.cwd()` elsewhere. */
export function __resetPluginGuideCacheForTests(): void {
  cache = undefined;
}

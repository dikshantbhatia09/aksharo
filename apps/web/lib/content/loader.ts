import fs from "node:fs";
import path from "node:path";

import matter from "gray-matter";
import { type z } from "zod";

import "server-only";

import {
  AcademyTrackFrontmatterSchema,
  ChangelogFrontmatterSchema,
  HelpArticleFrontmatterSchema,
  type AcademyTrack,
  type ChangelogEntry,
  type HelpArticle,
} from "./schema";

/**
 * File-system loader for the three MDX collections (brief §1: "validated at
 * build"). Server-only (`import "server-only"` — same guard `content/site`
 * doesn't need because it is plain `.ts`, but MDX is read from disk here so
 * this must never end up in a client bundle).
 *
 * Every collection is read once per process and cached — the content is
 * static per deploy, and re-reading fs on every request would cost a
 * syscall per article for no benefit. `pnpm --filter @montaj/web test`
 * exercises every file through `content.schema.test.ts`, so a bad frontmatter
 * fails CI before it ever reaches this loader in production.
 */
const CONTENT_ROOT = path.join(process.cwd(), "content");

function readMdxFiles(collection: string): { readonly slug: string; readonly raw: string }[] {
  const dir = path.join(CONTENT_ROOT, collection);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => ({
      slug: file.replace(/\.mdx$/, ""),
      raw: fs.readFileSync(path.join(dir, file), "utf8"),
    }));
}

function parseOrThrow<T>(schema: z.ZodType<T>, collection: string, file: string, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `content/${collection}/${file}.mdx has invalid frontmatter: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

let academyCache: readonly AcademyTrack[] | undefined;
let helpCache: readonly HelpArticle[] | undefined;
let changelogCache: readonly ChangelogEntry[] | undefined;

export function loadAcademyTracks(): readonly AcademyTrack[] {
  if (!academyCache) {
    academyCache = readMdxFiles("academy")
      .map(({ slug: file, raw }) => {
        const { data, content } = matter(raw);
        const frontmatter = parseOrThrow(AcademyTrackFrontmatterSchema, "academy", file, data);
        return { ...frontmatter, body: content.trim() };
      })
      .sort((a, b) => a.order - b.order);
  }
  return academyCache;
}

export function getAcademyTrack(trackId: string): AcademyTrack | undefined {
  return loadAcademyTracks().find((track) => track.id === trackId);
}

export function loadHelpArticles(): readonly HelpArticle[] {
  if (!helpCache) {
    helpCache = readMdxFiles("help")
      .map(({ slug: file, raw }) => {
        const { data, content } = matter(raw);
        const frontmatter = parseOrThrow(HelpArticleFrontmatterSchema, "help", file, data);
        return { ...frontmatter, body: content.trim() };
      })
      .sort((a, b) => a.order - b.order);
  }
  return helpCache;
}

export function getHelpArticle(slug: string): HelpArticle | undefined {
  return loadHelpArticles().find((article) => article.slug === slug);
}

export function getHelpArticleByHelpSlug(helpSlug: string): HelpArticle | undefined {
  return loadHelpArticles().find((article) => article.helpSlug === helpSlug);
}

export function loadChangelogEntries(): readonly ChangelogEntry[] {
  if (!changelogCache) {
    changelogCache = readMdxFiles("changelog")
      .map(({ raw }) => {
        const { data, content } = matter(raw);
        const frontmatter = parseOrThrow(
          ChangelogFrontmatterSchema,
          "changelog",
          data.version ?? "unknown",
          data,
        );
        return { ...frontmatter, body: content.trim() };
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  return changelogCache;
}

/** Current version = the newest changelog entry's version, or `null` if none exist yet. */
export function currentChangelogVersion(): string | null {
  const entries = loadChangelogEntries();
  return entries.length > 0 ? (entries[0]?.version ?? null) : null;
}

/** Test-only: clears the module caches so a test can point `process.cwd()` elsewhere. */
export function __resetContentCacheForTests(): void {
  academyCache = undefined;
  helpCache = undefined;
  changelogCache = undefined;
}

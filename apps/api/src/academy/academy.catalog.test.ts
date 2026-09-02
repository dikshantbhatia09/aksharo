import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import matter from "gray-matter";
import { describe, expect, it } from "vitest";

import { ACADEMY_TRACKS } from "./academy.catalog.js";

/**
 * The sync check `academy.catalog.ts`'s doc comment promises: re-derives the
 * track/step/`completionEvent`/`creditReward` shape from the MDX frontmatter
 * in `apps/web/content/academy/*.mdx` and fails if this file's hand-kept
 * catalogue has drifted from it. Reads the sibling app's content directory
 * directly (via `gray-matter`, a devDependency here) rather than importing
 * `apps/web`'s loader — that loader is `server-only` and Next-specific;
 * this only needs the raw frontmatter.
 */
const WEB_CONTENT_DIR = path.resolve(__dirname, "..", "..", "..", "web", "content", "academy");

interface ContentTrack {
  readonly id: string;
  readonly creditReward: number;
  readonly steps: { readonly id: string; readonly completionEvent?: string }[];
}

function loadContentTracks(): ContentTrack[] {
  return readdirSync(WEB_CONTENT_DIR)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => {
      const raw = readFileSync(path.join(WEB_CONTENT_DIR, file), "utf8");
      const { data } = matter(raw);
      return data as ContentTrack;
    });
}

describe("academy catalogue vs. apps/web/content/academy MDX", () => {
  const contentAvailable = (() => {
    try {
      readdirSync(WEB_CONTENT_DIR);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!contentAvailable)("has exactly the same track ids", () => {
    const contentIds = loadContentTracks()
      .map((track) => track.id)
      .sort();
    const catalogIds = ACADEMY_TRACKS.map((track) => track.id).sort();
    expect(catalogIds).toEqual(contentIds);
  });

  it.skipIf(!contentAvailable)("matches step ids, completionEvent and creditReward per track", () => {
    const byId = new Map(loadContentTracks().map((track) => [track.id, track]));
    for (const catalogTrack of ACADEMY_TRACKS) {
      const contentTrack = byId.get(catalogTrack.id);
      expect(contentTrack, `content track "${catalogTrack.id}" is missing`).toBeDefined();
      if (!contentTrack) continue;

      expect(catalogTrack.creditReward, `${catalogTrack.id} creditReward`).toBe(contentTrack.creditReward);
      expect(
        catalogTrack.steps.map((step) => step.id),
        `${catalogTrack.id} step ids`,
      ).toEqual(contentTrack.steps.map((step) => step.id));
      expect(
        catalogTrack.steps.map((step) => step.completionEvent ?? null),
        `${catalogTrack.id} completionEvent per step`,
      ).toEqual(contentTrack.steps.map((step) => step.completionEvent ?? null));
    }
  });
});

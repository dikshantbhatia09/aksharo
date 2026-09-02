import { describe, expect, it } from "vitest";

import { loadAcademyTracks, loadChangelogEntries, loadHelpArticles } from "./loader.js";

/**
 * "Invalid frontmatter fails the build" (brief §1 & §6): every file under
 * `content/{academy,help,changelog}` is parsed and zod-validated as a side
 * effect of importing `loader.ts` — a bad file throws inside `loadX()` here
 * before it ever reaches a page component or the API's seed.
 */
describe("academy content", () => {
  it("loads all seed tracks without a schema error", () => {
    const tracks = loadAcademyTracks();
    expect(tracks.length).toBeGreaterThanOrEqual(4);
  });

  it("has unique track ids and step ids per track", () => {
    const tracks = loadAcademyTracks();
    const ids = tracks.map((track) => track.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const track of tracks) {
      const stepIds = track.steps.map((step) => step.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
    }
  });

  it("caps every track's reward at 25 credits and keeps the lifetime total at or under 100", () => {
    const tracks = loadAcademyTracks();
    for (const track of tracks) expect(track.creditReward).toBeLessThanOrEqual(25);
    const total = tracks.reduce((sum, track) => sum + track.creditReward, 0);
    expect(total).toBeLessThanOrEqual(100);
  });

  it("every track has non-empty body content (no lorem ipsum placeholders)", () => {
    for (const track of loadAcademyTracks()) {
      expect(track.body.length).toBeGreaterThan(50);
      expect(track.body.toLowerCase()).not.toContain("lorem ipsum");
    }
  });
});

describe("help content", () => {
  it("loads at least ten articles", () => {
    expect(loadHelpArticles().length).toBeGreaterThanOrEqual(10);
  });

  it("has unique slugs and helpSlugs", () => {
    const articles = loadHelpArticles();
    expect(new Set(articles.map((article) => article.slug)).size).toBe(articles.length);
    expect(new Set(articles.map((article) => article.helpSlug)).size).toBe(articles.length);
  });

  it("has real content, no lorem ipsum", () => {
    for (const article of loadHelpArticles()) {
      expect(article.body.length).toBeGreaterThan(50);
      expect(article.body.toLowerCase()).not.toContain("lorem ipsum");
    }
  });
});

describe("changelog content", () => {
  it("has at least one entry, the current version", () => {
    const entries = loadChangelogEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is sorted newest first by date", () => {
    const entries = loadChangelogEntries();
    const dates = entries.map((entry) => entry.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

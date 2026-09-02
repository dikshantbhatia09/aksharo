import { describe, expect, it } from "vitest";

import { classifyCommit, computeNextVersion, insertChangelogSection, renderChangelogSection, groupCommitsForChangelog } from "../src/commands/version.js";

describe("classifyCommit", () => {
  it("classifies feat/fix/breaking/other", () => {
    expect(classifyCommit("feat(release): add publish command")).toBe("minor");
    expect(classifyCommit("fix(release): correct 24h math")).toBe("patch");
    expect(classifyCommit("feat!: drop legacy provider")).toBe("major");
    expect(classifyCommit("chore: bump deps")).toBeNull();
    expect(classifyCommit("random commit message")).toBeNull();
  });
});

describe("computeNextVersion", () => {
  it("bumps patch for fix-only commit sets", () => {
    expect(computeNextVersion("1.2.3", ["fix: a", "chore: b"])).toEqual({ next: "1.2.4", bump: "patch" });
  });
  it("bumps minor when a feat is present, even alongside fixes", () => {
    expect(computeNextVersion("1.2.3", ["fix: a", "feat: b"])).toEqual({ next: "1.3.0", bump: "minor" });
  });
  it("bumps major on a breaking-change commit", () => {
    expect(computeNextVersion("1.2.3", ["feat!: a"])).toEqual({ next: "2.0.0", bump: "major" });
  });
  it("does not bump when there is nothing version-worthy", () => {
    expect(computeNextVersion("1.2.3", ["chore: a", "docs: b"])).toEqual({ next: "1.2.3", bump: null });
  });
});

describe("changelog assembly", () => {
  it("groups and renders a section", () => {
    const section = groupCommitsForChangelog(["feat: add publish", "fix: 24h math", "chore: tidy"], "1.3.0", "2026-09-03");
    const rendered = renderChangelogSection(section);
    expect(rendered).toContain("## 1.3.0 — 2026-09-03");
    expect(rendered).toContain("- add publish");
    expect(rendered).toContain("- 24h math");
  });

  it("inserts right after the Unreleased heading", () => {
    const changelog = "# Changelog\n\n## Unreleased\n\n- pending work\n\n## 0.9.0 — 2026-08-01\n";
    const inserted = insertChangelogSection(changelog, "## 1.0.0 — 2026-09-03\n\n- x\n");
    const unreleasedIdx = inserted.indexOf("## Unreleased");
    const newSectionIdx = inserted.indexOf("## 1.0.0");
    const oldSectionIdx = inserted.indexOf("## 0.9.0");
    expect(unreleasedIdx).toBeLessThan(newSectionIdx);
    expect(newSectionIdx).toBeLessThan(oldSectionIdx);
  });
});

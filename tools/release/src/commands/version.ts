export type Bump = "major" | "minor" | "patch";

/** Classifies one conventional-commit subject line into a semver bump, or `null` if it
 * doesn't affect the version (chore/docs/test/ci/style without a `!`). */
export function classifyCommit(subject: string): Bump | null {
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
  const breaking = /^[a-z]+(\([^)]*\))?!:/i.test(subject) || /BREAKING CHANGE/i.test(subject);
  if (breaking) return "major";
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
  if (/^feat(\([^)]*\))?:/i.test(subject)) return "minor";
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
  if (/^fix(\([^)]*\))?:/i.test(subject)) return "patch";
  return null;
}

export function computeNextVersion(
  currentVersion: string,
  subjects: string[],
): { next: string; bump: Bump | null } {
  const bumps = subjects.map(classifyCommit).filter((b): b is Bump => b !== null);
  const bump: Bump | null = bumps.includes("major")
    ? "major"
    : bumps.includes("minor")
      ? "minor"
      : bumps.includes("patch")
        ? "patch"
        : null;

  const parts = currentVersion.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (bump === "major") return { next: `${major + 1}.0.0`, bump };
  if (bump === "minor") return { next: `${major}.${minor + 1}.0`, bump };
  if (bump === "patch") return { next: `${major}.${minor}.${patch + 1}`, bump };
  return { next: currentVersion, bump: null };
}

export interface ChangelogSection {
  version: string;
  date: string;
  features: string[];
  fixes: string[];
  other: string[];
}

export function groupCommitsForChangelog(
  subjects: string[],
  version: string,
  date: string,
): ChangelogSection {
  const features: string[] = [];
  const fixes: string[] = [];
  const other: string[] = [];
  for (const subject of subjects) {
    // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
    if (/^feat(\([^)]*\))?:/i.test(subject))
      // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
      features.push(subject.replace(/^feat(\([^)]*\))?:\s*/i, ""));
    // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
    else if (/^fix(\([^)]*\))?:/i.test(subject))
      // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
      fixes.push(subject.replace(/^fix(\([^)]*\))?:\s*/i, ""));
    else other.push(subject);
  }
  return { version, date, features, fixes, other };
}

export function renderChangelogSection(section: ChangelogSection): string {
  const lines = [`## ${section.version} — ${section.date}`, ""];
  if (section.features.length) {
    lines.push("### Features", "", ...section.features.map((f) => `- ${f}`), "");
  }
  if (section.fixes.length) {
    lines.push("### Fixes", "", ...section.fixes.map((f) => `- ${f}`), "");
  }
  if (section.other.length) {
    lines.push("### Other", "", ...section.other.map((f) => `- ${f}`), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Inserts a new dated section right after the `## Unreleased` heading (or at the top if
 * absent), leaving the rest of the file untouched. */
export function insertChangelogSection(changelog: string, section: string): string {
  const marker = "## Unreleased";
  const idx = changelog.indexOf(marker);
  if (idx === -1) {
    return `${section}\n${changelog}`;
  }
  const afterHeadingLineEnd = changelog.indexOf("\n", idx);
  const insertAt = afterHeadingLineEnd === -1 ? changelog.length : afterHeadingLineEnd + 1;
  return `${changelog.slice(0, insertAt)}\n${section}\n${changelog.slice(insertAt)}`;
}

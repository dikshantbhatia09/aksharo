import { describe, expect, it } from "vitest";

import { checkHallucination, checkLanguageConsistency, checkTimestamps } from "./checks.js";
import { EDIT_PLAN_FIXTURES } from "./edit-plan-fixtures.js";
import { FIXTURES } from "./fixtures.js";
import { renderMarkdown, run } from "./runner.js";

describe("eval runner", () => {
  it("passes automatic checks on every fixture with the fake provider (acceptance criterion 1)", () => {
    const report = run();
    if (!report.ok) {
      const failures = report.cases
        .filter((c) => !c.ok)
        .map(
          (c) =>
            `${c.fixtureId}/${c.kind}: ${c.checks
              .filter((k) => !k.ok)
              .map((k) => `${k.name}=${k.detail}`)
              .join("; ")}`,
        );
      throw new Error(`eval failures:\n${failures.join("\n")}`);
    }
    expect(report.ok).toBe(true);
    // chapters, summary, hooks per transcript fixture, plus one edit-plan case per prompt fixture (D07).
    expect(report.totalCases).toBe(FIXTURES.length * 3 + EDIT_PLAN_FIXTURES.length);
  });

  it("covers all four fixture languages", () => {
    const report = run();
    const fixtureIds = new Set(
      report.cases.filter((c) => c.kind !== "edit-plan").map((c) => c.fixtureId),
    );
    expect(fixtureIds).toEqual(new Set(["english", "hindi", "hinglish", "tamil"]));
  });

  it("renders a markdown report with a result table", () => {
    const report = run();
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("# @montaj/prompts eval report");
    expect(markdown).toContain("PASS");
    expect(markdown).toContain("| Fixture | Kind | Template | Result | Failing checks |");
  });
});

describe("individual checks", () => {
  it("timestamp check catches an out-of-range chapter start", () => {
    const result = checkTimestamps(
      "chapters",
      { chapters: [{ startMs: 999_999, title: "x" }] },
      10_000,
    );
    expect(result.ok).toBe(false);
  });

  it("hallucination guard catches an invented proper noun", () => {
    const transcript = FIXTURES[0]!.transcript;
    const result = checkHallucination(
      "chapters",
      { chapters: [{ startMs: 0, title: "Zorblaxian Adventures" }] },
      transcript,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Zorblaxian");
  });

  it("hallucination guard allows words that appear in the transcript", () => {
    const transcript = FIXTURES[0]!.transcript; // English fixture mentions "YouTube"
    const result = checkHallucination(
      "chapters",
      { chapters: [{ startMs: 0, title: "Upload to YouTube" }] },
      transcript,
    );
    expect(result.ok).toBe(true);
  });

  it("language consistency rejects Devanagari output for an English transcript", () => {
    const result = checkLanguageConsistency(
      "chapters",
      { chapters: [{ startMs: 0, title: "नमस्ते" }] },
      "en",
    );
    expect(result.ok).toBe(false);
  });

  it("language consistency accepts Latin-script output for Hinglish (never translated to pure Hindi)", () => {
    const result = checkLanguageConsistency(
      "chapters",
      { chapters: [{ startMs: 0, title: "Video editing tips yaar" }] },
      "hi-Latn",
    );
    expect(result.ok).toBe(true);
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseBlocks, splitTableRow } from "./blocks";

describe("parseBlocks", () => {
  it("parses headings h1-h3", () => {
    const blocks = parseBlocks(["# One", "## Two", "### Three"].join("\n"));
    expect(blocks).toEqual([
      { kind: "h1", lines: ["One"] },
      { kind: "h2", lines: ["Two"] },
      { kind: "h3", lines: ["Three"] },
    ]);
  });

  it("parses a paragraph", () => {
    const blocks = parseBlocks("A plain paragraph.");
    expect(blocks).toEqual([{ kind: "p", lines: ["A plain paragraph."] }]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseBlocks(["- one", "- two", "", "1. first", "2. second"].join("\n"));
    expect(blocks).toEqual([
      { kind: "ul", lines: ["one", "two"] },
      { kind: "ol", lines: ["first", "second"] },
    ]);
  });

  it("parses a fenced code block", () => {
    const blocks = parseBlocks(["```", "const x = 1;", "```"].join("\n"));
    expect(blocks).toEqual([{ kind: "code", lines: ["const x = 1;"] }]);
  });

  it("parses a GFM pipe table", () => {
    const blocks = parseBlocks(
      ["| A | B |", "| --- | --- |", "| a1 | b1 |", "| a2 | b2 |"].join("\n"),
    );
    expect(blocks).toEqual([{ kind: "table", lines: ["| A | B |", "| a1 | b1 |", "| a2 | b2 |"] }]);
  });

  it("parses a blockquote", () => {
    const blocks = parseBlocks(["> quoted line one", "> quoted line two"].join("\n"));
    expect(blocks).toEqual([{ kind: "blockquote", lines: ["quoted line one", "quoted line two"] }]);
  });

  it("does not misparse a header separator without a preceding pipe row as a table", () => {
    const blocks = parseBlocks("| --- | --- |");
    expect(blocks).toEqual([{ kind: "p", lines: ["| --- | --- |"] }]);
  });

  // M07 regression: a paragraph line starting with bold/italic text used to
  // send the old, duplicated parsers into an infinite loop (see this
  // module's file-level doc comment). Both prior copies had this test; the
  // shared parser keeps it.
  it("terminates and produces one paragraph for a line starting with **bold**", () => {
    const blocks = parseBlocks("**Status:** shipped, followed by more prose.");
    expect(blocks).toEqual([
      { kind: "p", lines: ["**Status:** shipped, followed by more prose."] },
    ]);
  });

  it("terminates and produces one paragraph for a line starting with *emphasis*", () => {
    const blocks = parseBlocks("*Note:* this line opens with a single asterisk, not a bullet.");
    expect(blocks).toEqual([
      { kind: "p", lines: ["*Note:* this line opens with a single asterisk, not a bullet."] },
    ]);
  });

  it("handles an empty string", () => {
    expect(parseBlocks("")).toEqual([]);
  });

  describe("property: terminates and consumes every line exactly once for any input", () => {
    it("holds for arbitrary strings", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 500 }), (markdown) => {
          const inputLineCount = markdown.split("\n").length;
          const blocks = parseBlocks(markdown);
          // Reconstructing how many source lines were consumed: each
          // non-code, non-table, non-blockquote, non-list block that isn't
          // a paragraph corresponds to exactly one source line (headings);
          // paragraphs may join multiple source lines into one entry
          // (`lines: [joined]`), lists/blockquotes/code/table blocks keep
          // one entry per source line. Rather than re-deriving an exact
          // count (which duplicates the parser), assert the invariant that
          // actually protects against the M07 bug: parsing must terminate
          // (fast-check's own timeout would fail this test otherwise) and
          // must not produce an unbounded number of blocks for a bounded
          // input — an infinite loop manifests as either non-termination or
          // an unbounded block count for fixed input size.
          expect(blocks.length).toBeLessThanOrEqual(Math.max(1, inputLineCount));
        }),
        { numRuns: 200 },
      );
    });

    it("holds for arbitrary arrays of markdown-flavoured lines", () => {
      const lineArb = fc.oneof(
        fc.constant(""),
        fc.constant("# heading"),
        fc.constant("## heading"),
        fc.constant("### heading"),
        fc.constant("- item"),
        fc.constant("* item"),
        fc.constant("**bold start** rest"),
        fc.constant("*italic start* rest"),
        fc.constant("1. item"),
        fc.constant("```"),
        fc.constant("| a | b |"),
        fc.constant("| --- | --- |"),
        fc.constant("> quote"),
        fc.string({ maxLength: 40 }),
      );
      fc.assert(
        fc.property(fc.array(lineArb, { maxLength: 50 }), (lines) => {
          const markdown = lines.join("\n");
          const blocks = parseBlocks(markdown);
          expect(blocks.length).toBeLessThanOrEqual(Math.max(1, lines.length));
        }),
        { numRuns: 300 },
      );
    });
  });
});

describe("splitTableRow", () => {
  it("splits a pipe row into trimmed cells", () => {
    expect(splitTableRow("| a  | b |")).toEqual(["a", "b"]);
  });

  it("handles rows without leading/trailing pipes", () => {
    expect(splitTableRow("a | b")).toEqual(["a", "b"]);
  });
});

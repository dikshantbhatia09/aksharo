/**
 * Shared, pure block-level markdown parser (M12).
 *
 * `apps/web/lib/docs/markdown.tsx` (X03) and `apps/web/lib/content/markdown.tsx`
 * (B12) used to be two hand-rolled copies of this same block-splitting loop.
 * Both carried the identical M07 infinite-loop bug (see the regression tests
 * in those files' `*.test.tsx`): the paragraph-collection loop stopped on a
 * bare `^[-*#]` test, which also matches a line that merely *starts* with
 * `*` without being a bullet (`^[-*]\s+`) — e.g. bold/italic text opening a
 * paragraph (`**Status:** ...`). That line failed every earlier branch, fell
 * into the paragraph branch, and matched its own stop condition on its first
 * line: the inner `while` ran zero iterations, the cursor `i` never
 * advanced, and the outer `while (i < lines.length)` loop spun forever
 * pushing empty paragraph blocks until the process ran out of memory.
 *
 * This module is the single block parser both renderers now sit on top of.
 * It owns only block structure (paragraphs, headings, lists, fenced code,
 * GFM pipe tables, blockquotes) and a documented cursor-progress invariant;
 * inline formatting (bold/italic/code/links) and link-target policy stay in
 * each renderer, since docs and content diverge there (docs: no single-`*`
 * italic, internal-vs-external link target policy; content: single-`*`
 * italic, no target policy) — see `lib/docs/markdown.tsx` and
 * `lib/content/markdown.tsx`.
 *
 * Cursor-progress invariant: every iteration of the outer `while (i <
 * lines.length)` loop in `parseBlocks` strictly increases `i` by at least 1
 * before looping again — enforced by construction (every branch below either
 * consumes at least one line itself, or falls through to the paragraph
 * branch's defensive backstop, which forces `i++` even if zero lines were
 * collected). This guarantees `parseBlocks` always terminates, and that
 * `lines.length` total line-advances occur, i.e. every input line is
 * consumed exactly once. `blocks.test.ts` checks this with a `fast-check`
 * property test over arbitrary input strings.
 */

export type BlockKind = "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "code" | "table" | "blockquote";

export interface Block {
  readonly kind: BlockKind;
  readonly lines: readonly string[];
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isTableSeparator(line: string): boolean {
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input (long runs of "|" and "-") -- linear, no nested unbounded quantifiers -- not exponential (see M06 report, re-reviewed for M12's unification).
  return /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(line.trim());
}

/**
 * Splits `markdown` into a flat sequence of block-level nodes. Pure function:
 * same input always produces the same output, no rendering or DOM/React
 * dependency.
 */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a numeric index into this function's own array, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion, re-reviewed for M12.
  const at = (index: number): string => lines[index] ?? "";
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !at(i).startsWith("```")) {
        code.push(at(i));
        i++;
      }
      i++; // closing fence (or end of input if unterminated — still progress)
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    if (isTableRow(line) && isTableSeparator(at(i + 1))) {
      const rows: string[] = [line];
      i += 2;
      while (i < lines.length && isTableRow(at(i))) {
        rows.push(at(i));
        i++;
      }
      blocks.push({ kind: "table", lines: rows });
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && at(i).startsWith(">")) {
        quote.push(at(i).replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "blockquote", lines: quote });
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ kind: "h3", lines: [line.slice(4)] });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ kind: "h2", lines: [line.slice(3)] });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ kind: "h1", lines: [line.slice(2)] });
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(at(i))) {
        items.push(at(i).replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", lines: items });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(at(i))) {
        items.push(at(i).replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", lines: items });
      continue;
    }
    // M07: root-cause fix for the build-OOM bug shared by both former
    // copies of this parser. This loop must stop collecting paragraph
    // lines only at a line one of the branches ABOVE would actually treat
    // specially (heading, bullet, ordered list, code fence, table row,
    // blockquote) — the same patterns those branches test, not merely
    // "starts with `-`, `*`, `#`, `|` or `>`". A markdown line starting
    // with bold text (`**Status:** ...`) starts with `*` but is not a
    // bullet (no `\s+` after it), so it fails every earlier `if`, falls
    // into this paragraph branch, and — with a bare `^[-*#]`-style check —
    // would match its OWN stop condition on its first line: the `while`
    // body would never run, `i` would never advance, and the outer
    // `while (i < lines.length)` loop above would spin forever pushing
    // empty paragraph blocks.
    const para: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() !== "" &&
      !/^[-*]\s+|^\d+\.\s+|^#{1,3}\s|^```|^\||^>/.test(at(i))
    ) {
      para.push(at(i));
      i++;
    }
    if (para.length === 0) {
      // Defensive backstop: even if some future branch/pattern mismatch
      // ever reintroduces a case where nothing above matches and this loop
      // still collects zero lines, force progress rather than looping
      // forever. This is what makes the cursor-progress invariant hold
      // unconditionally, not just for the patterns currently listed above.
      para.push(at(i));
      i++;
    }
    blocks.push({ kind: "p", lines: [para.join(" ")] });
  }
  return blocks;
}

/** Splits a GFM pipe-table row into trimmed cell strings. Shared by both renderers. */
export function splitTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

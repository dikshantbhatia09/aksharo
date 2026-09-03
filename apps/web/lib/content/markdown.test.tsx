import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "./markdown";

describe("MarkdownBody regression: paragraph lines starting with * or **", () => {
  // M07: the sibling `lib/docs/markdown.tsx` had an infinite-loop bug in
  // `toBlocks()`'s paragraph-collection loop — it stopped on a bare
  // `^[-*#]` test, which also matches a line that merely starts with `*`
  // without being a bullet (`^[-*]\s+`), e.g. bold or italic text opening a
  // paragraph. That line failed every earlier branch, fell into the
  // paragraph branch, and matched its own stop condition on its first line:
  // the collection loop ran zero iterations, the cursor never advanced, and
  // the outer loop pushed empty paragraph blocks forever until the process
  // ran out of memory. This file (B12's own copy of the same parser
  // structure) carried the identical bug — no current academy/help/
  // changelog body happened to trigger it, but any future one starting a
  // paragraph with bold or italic text would have. These render calls must
  // terminate and must not produce empty paragraphs.
  it("terminates and renders one paragraph for a line starting with **bold**", () => {
    const { container } = render(
      <MarkdownBody
        markdown={["**Status:** shipped, followed by more prose on the same paragraph."].join("\n")}
      />,
    );
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.textContent).toContain("Status:");
    expect(paragraphs[0]?.textContent).toContain("same paragraph.");
  });

  it("terminates and renders one paragraph for a line starting with *emphasis*", () => {
    const { container } = render(
      <MarkdownBody
        markdown={["*Note:* this line opens with a single asterisk, not a bullet."].join("\n")}
      />,
    );
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.textContent).toContain("Note:");
    expect(paragraphs[0]?.textContent).toContain("not a bullet.");
  });
});

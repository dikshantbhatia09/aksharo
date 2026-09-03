import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DocsMarkdownBody } from "./markdown";

describe("DocsMarkdownBody", () => {
  it("renders headings, paragraphs, lists and code fences", () => {
    render(
      <DocsMarkdownBody
        markdown={[
          "# Title",
          "",
          "## Section",
          "",
          "A paragraph with **bold** and `code`.",
          "",
          "- one",
          "- two",
          "",
          "```",
          "const x = 1;",
          "```",
        ].join("\n")}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Section" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
  });

  it("renders a pipe table as an HTML table", () => {
    render(
      <DocsMarkdownBody
        markdown={[
          "| Path | What |",
          "| --- | --- |",
          "| `a.ts` | thing a |",
          "| `b.ts` | thing b |",
        ].join("\n")}
      />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Path" })).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("thing b")).toBeInTheDocument();
  });

  it("renders an internal link without target=_blank and an external one with it", () => {
    render(
      <DocsMarkdownBody
        markdown={["[internal](/docs/guides/foo) and [external](https://example.com)"].join("\n")}
      />,
    );
    const internal = screen.getByRole("link", { name: "internal" });
    const external = screen.getByRole("link", { name: "external" });
    expect(internal).not.toHaveAttribute("target");
    expect(external).toHaveAttribute("target", "_blank");
  });
});

describe("DocsMarkdownBody regression: paragraph lines starting with * or **", () => {
  // M07: `toBlocks()`'s paragraph-collection loop used to stop on a bare
  // `^[-*#]` test, which also matches a line that merely starts with `*`
  // without being a bullet (`^[-*]\s+`) — e.g. bold or italic text opening a
  // paragraph. That line failed every earlier branch, fell into the
  // paragraph branch, and matched its own stop condition on its first line:
  // the collection loop ran zero iterations, the cursor never advanced, and
  // the outer loop pushed empty paragraph blocks forever. This is exactly
  // what every `plugins/*/README.md` hit (they open with `**Status:** ...`)
  // and it alone was enough to run a static-generation worker out of memory.
  // These render calls must terminate and must not produce empty paragraphs.
  it("terminates and renders one paragraph for a line starting with **bold**", () => {
    const { container } = render(
      <DocsMarkdownBody
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
      <DocsMarkdownBody
        markdown={["*Note:* this line opens with a single asterisk, not a bullet."].join("\n")}
      />,
    );
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.textContent).toContain("Note:");
    expect(paragraphs[0]?.textContent).toContain("not a bullet.");
  });
});

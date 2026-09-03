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

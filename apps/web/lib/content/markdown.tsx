import React from "react";

/**
 * A deliberately small markdown-to-React renderer for the academy/help/
 * changelog body text: headings, paragraphs, bullet and numbered lists,
 * fenced code blocks, and inline `bold`/`italic`/`code`/links. This is not a
 * CommonMark implementation — it covers exactly what the seed content in
 * `apps/web/content/**` uses — chosen over pulling in `remark`/`rehype`/an
 * MDX compiler to keep this work package's dependency footprint to the two
 * additive, pure-JS libraries (`gray-matter`, `minisearch`) noted in the
 * final report, on a shared 16 GB build host.
 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${i++}`}>{match[3]}</em>);
    } else if (match[4] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-${i++}`} className="bg-bg-2 rounded px-1 py-0.5 text-2xs">
          {match[4]}
        </code>,
      );
    } else if (match[5] !== undefined && match[6] !== undefined) {
      nodes.push(
        <a key={`${keyPrefix}-${i++}`} href={match[6]} className="text-accent underline">
          {match[5]}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

interface Block {
  readonly kind: "h2" | "h3" | "p" | "ul" | "ol" | "code";
  readonly lines: readonly string[];
}

function toBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
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
      i++; // closing fence
      blocks.push({ kind: "code", lines: code });
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
    const para: string[] = [];
    while (i < lines.length && at(i).trim() !== "" && !/^[-*#]|^\d+\.\s+|^```/.test(at(i))) {
      para.push(at(i));
      i++;
    }
    blocks.push({ kind: "p", lines: [para.join(" ")] });
  }
  return blocks;
}

export function MarkdownBody({ markdown }: { readonly markdown: string }): React.JSX.Element {
  const blocks = toBlocks(markdown);
  return (
    <div className="prose-content flex flex-col gap-4">
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case "h2":
            return (
              <h2 key={key} className="text-fg-0 text-xl font-semibold">
                {renderInline(block.lines[0] ?? "", key)}
              </h2>
            );
          case "h3":
            return (
              <h3 key={key} className="text-fg-0 text-lg font-semibold">
                {renderInline(block.lines[0] ?? "", key)}
              </h3>
            );
          case "code":
            return (
              <pre key={key} className="bg-bg-2 overflow-x-auto rounded-md p-3 text-xs">
                <code>{block.lines.join("\n")}</code>
              </pre>
            );
          case "ul":
            return (
              <ul key={key} className="text-fg-1 list-disc pl-5 text-sm leading-relaxed">
                {block.lines.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="text-fg-1 list-decimal pl-5 text-sm leading-relaxed">
                {block.lines.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ol>
            );
          case "p":
          default:
            return (
              <p key={key} className="text-fg-1 text-sm leading-relaxed">
                {renderInline(block.lines[0] ?? "", key)}
              </p>
            );
        }
      })}
    </div>
  );
}

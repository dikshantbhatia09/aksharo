import React from "react";

/**
 * `/docs`'s own small markdown-to-React renderer. `lib/content/markdown.tsx`
 * (B12) already does this for the academy/help/changelog bodies, but the
 * plugin READMEs this generator also renders (brief §2: "plugin READMEs ->
 * guide pages") use GitHub-flavoured pipe tables, which that renderer does
 * not parse — extending B12's copy in place would touch a file outside this
 * WP's boundary (`lib/content/**`), so this is a sibling copy with table
 * support added, kept in `lib/docs/**` instead.
 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-${i++}`} className="bg-bg-2 rounded px-1 py-0.5 text-2xs">
          {match[3]}
        </code>,
      );
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const href = match[5];
      const isInternal = href.startsWith("/") || href.startsWith("#");
      nodes.push(
        <a
          key={`${keyPrefix}-${i++}`}
          href={href}
          className="text-accent underline"
          {...(isInternal ? {} : { target: "_blank", rel: "noreferrer" })}
        >
          {match[4]}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

interface Block {
  readonly kind: "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "code" | "table";
  readonly lines: readonly string[];
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|");
}

function isTableSeparator(line: string): boolean {
  // eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input (long runs of "|" and "-") -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
  return /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(line.trim());
}

function toBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a numeric index into this function's own array, not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
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
    const para: string[] = [];
    while (i < lines.length && at(i).trim() !== "" && !/^[-*#]|^\d+\.\s+|^```|^\|/.test(at(i))) {
      para.push(at(i));
      i++;
    }
    blocks.push({ kind: "p", lines: [para.join(" ")] });
  }
  return blocks;
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function DocsTable({
  rows,
  keyPrefix,
}: {
  rows: readonly string[];
  keyPrefix: string;
}): React.JSX.Element {
  const [header, ...body] = rows;
  const headerCells = splitRow(header ?? "");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-border border-b text-left">
            {headerCells.map((cell, index) => (
              <th key={`${keyPrefix}-h-${index}`} className="py-2 pr-4 font-medium">
                {renderInline(cell, `${keyPrefix}-h-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={`${keyPrefix}-r-${rowIndex}`} className="border-border/50 border-b">
              {splitRow(row).map((cell, cellIndex) => (
                <td key={`${keyPrefix}-r-${rowIndex}-${cellIndex}`} className="text-fg-1 py-2 pr-4">
                  {renderInline(cell, `${keyPrefix}-r-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocsMarkdownBody({ markdown }: { readonly markdown: string }): React.JSX.Element {
  const blocks = toBlocks(markdown);
  return (
    <div className="prose-content flex flex-col gap-4">
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case "h1":
            return (
              <h1 key={key} className="text-fg-0 text-2xl font-semibold">
                {renderInline(block.lines[0] ?? "", key)}
              </h1>
            );
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
          case "table":
            return <DocsTable key={key} rows={block.lines} keyPrefix={key} />;
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

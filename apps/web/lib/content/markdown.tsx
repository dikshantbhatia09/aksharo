import React from "react";

import { parseBlocks, splitTableRow, type Block } from "@/lib/markdown/blocks";

/**
 * A deliberately small markdown-to-React renderer for the academy/help/
 * changelog body text: headings, paragraphs, bullet and numbered lists,
 * fenced code blocks, and inline `bold`/`italic`/`code`/links. This is not a
 * CommonMark implementation — it covers exactly what the seed content in
 * `apps/web/content/**` uses — chosen over pulling in `remark`/`rehype`/an
 * MDX compiler to keep this work package's dependency footprint to the two
 * additive, pure-JS libraries (`gray-matter`, `minisearch`) noted in the
 * final report, on a shared 16 GB build host.
 *
 * Sits on the shared block parser (`lib/markdown/blocks.ts`, M12), which
 * replaces this file's previously-duplicated `toBlocks()` — see that
 * module's doc comment for the M07 infinite-loop bug both copies carried and
 * the cursor-progress invariant that now prevents it. `lib/docs/markdown.tsx`
 * (X03) is the sibling renderer over the same shared blocks; it differs only
 * in inline policy (no single-`*` italic, internal-vs-external link
 * targets) needed for the plugin READMEs it also renders.
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

function ContentTable({
  rows,
  keyPrefix,
}: {
  rows: readonly string[];
  keyPrefix: string;
}): React.JSX.Element {
  const [header, ...body] = rows;
  const headerCells = splitTableRow(header ?? "");
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
              {splitTableRow(row).map((cell, cellIndex) => (
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

function renderBlock(block: Block, key: string): React.ReactNode {
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
      return <ContentTable key={key} rows={block.lines} keyPrefix={key} />;
    case "blockquote":
      return (
        <blockquote key={key} className="border-border text-fg-1 border-l-2 pl-3 text-sm italic">
          {block.lines.map((line, lineIndex) => (
            <p key={`${key}-${lineIndex}`}>{renderInline(line, `${key}-${lineIndex}`)}</p>
          ))}
        </blockquote>
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
}

export function MarkdownBody({ markdown }: { readonly markdown: string }): React.JSX.Element {
  const blocks = parseBlocks(markdown);
  return (
    <div className="prose-content flex flex-col gap-4">
      {blocks.map((block, index) => renderBlock(block, `block-${index}`))}
    </div>
  );
}

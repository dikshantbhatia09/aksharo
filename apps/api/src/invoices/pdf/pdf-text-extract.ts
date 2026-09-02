/**
 * A minimal, dependency-free text extractor for the PDFs `invoice-pdf.renderer.ts`
 * produces — used only by this work package's own text-extraction acceptance
 * tests (brief acceptance criterion 1).
 *
 * **Why not a library.** Every maintained pure-JS PDF text extractor available
 * to this work package is built on `pdfjs-dist`, and the version bundled by
 * `pdf-parse` (the obvious choice) throws `bad XRef entry` on a perfectly
 * valid, byte-identical PDF the moment `zlib` has been used anywhere earlier in
 * the same process — reproduced in isolation with `zlib.deflateSync` alone, no
 * `pdfkit` involved. Under Vitest's dependency graph something touches `zlib`
 * before any test body runs, so the failure is not avoidable by this work
 * package's own code (`renderInvoicePdf` already disables `pdfkit`'s own
 * compression for the same reason). Rather than depend on a broken package,
 * this file reads the one PDF construct the assertions need: the `Tj`/`TJ`
 * text-showing operators pdfkit itself emits.
 *
 * **Why this is safe to rely on.** `renderInvoicePdf` never embeds a custom
 * font (only the standard 14 PDF fonts, referenced by name), so with
 * `compress: false` there is exactly one `stream ... endstream` block per page
 * and it IS the content stream in plain PDF syntax — nothing binary, nothing
 * to inflate. `formatMoney` and every literal string this renderer writes are
 * ASCII, so no encoding table beyond `latin1` bytes-as-characters is needed.
 * This is not a general-purpose PDF parser; it does not need to be one.
 */

/** Extracts the visible text of every content stream in reading order. */
export function extractPdfText(pdfBytes: Buffer): string {
  const raw = pdfBytes.toString("latin1");
  const lines: string[] = [];

  const streamPattern = /stream\r?\n([\s\S]*?)endstream/g;
  let streamMatch: RegExpExecArray | null;
  while ((streamMatch = streamPattern.exec(raw)) !== null) {
    const content = streamMatch[1] ?? "";
    lines.push(...extractShowTextOperators(content));
  }

  return lines.join("\n");
}

function extractShowTextOperators(content: string): string[] {
  const results: string[] = [];

  // `(literal string) Tj` — pdfkit uses this for a run with no kerning pairs.
  const tjPattern = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  // `[ <hex> num (literal) num ... ] TJ` — pdfkit's usual form: a run split at
  // each kerned glyph pair, with a numeric adjustment between pieces.
  const tjArrayPattern = /\[((?:<[0-9A-Fa-f]*>|\((?:[^()\\]|\\.)*\)|[^[\]])*)\]\s*TJ/g;

  // Walk both patterns in document order by scanning once and dispatching on
  // whichever the cursor is currently sitting on.
  const combined =
    /(\((?:[^()\\]|\\.)*\)\s*Tj)|(\[(?:<[0-9A-Fa-f]*>|\((?:[^()\\]|\\.)*\)|[^[\]])*\]\s*TJ)/g;
  let match: RegExpExecArray | null;
  while ((match = combined.exec(content)) !== null) {
    const chunk = match[0];
    if (chunk.endsWith("Tj")) {
      tjPattern.lastIndex = 0;
      const inner = tjPattern.exec(chunk);
      if (inner?.[1] !== undefined) results.push(decodeLiteral(inner[1]));
    } else {
      tjArrayPattern.lastIndex = 0;
      const inner = tjArrayPattern.exec(chunk);
      if (inner?.[1] !== undefined) results.push(decodeArrayOperands(inner[1]));
    }
  }

  return results;
}

function decodeArrayOperands(arrayBody: string): string {
  let out = "";
  const tokenPattern = /<([0-9A-Fa-f]*)>|\(((?:[^()\\]|\\.)*)\)/g;
  let token: RegExpExecArray | null;
  while ((token = tokenPattern.exec(arrayBody)) !== null) {
    if (token[1] !== undefined) {
      out += decodeHex(token[1]);
    } else if (token[2] !== undefined) {
      out += decodeLiteral(token[2]);
    }
  }
  return out;
}

function decodeHex(hex: string): string {
  const evenLength = hex.length % 2 === 0 ? hex : `${hex}0`;
  let out = "";
  for (let i = 0; i < evenLength.length; i += 2) {
    out += String.fromCharCode(parseInt(evenLength.slice(i, i + 2), 16));
  }
  return out;
}

function decodeLiteral(literal: string): string {
  return literal.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_all, esc: string) => {
    switch (esc) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "(":
        return "(";
      case ")":
        return ")";
      case "\\":
        return "\\";
      default:
        return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

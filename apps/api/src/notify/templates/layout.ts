import { BRAND } from "@montaj/config";

/**
 * The shell every message is poured into: one hand-written responsive HTML
 * document and its plain-text twin.
 *
 * Hand-written rather than MJML because the whole set is one column, one button
 * and a footer — a compiler would be a build step and a dependency for markup
 * that fits on a screen. The rules it follows are the ones mail clients actually
 * enforce, and each is here for a reason worth keeping:
 *
 *   * a table, not a flex column: Outlook's Word rendering engine ignores modern
 *     layout entirely, and a table is the only thing every client agrees on;
 *   * inline styles: Gmail strips most of a `<style>` block, so the `<style>`
 *     here carries only the media query and the colour-scheme hints;
 *   * no remote images at all, so nothing is blocked by default and, more to the
 *     point, **there is no tracking pixel** — the platform does not learn whether
 *     a message was opened, and there is nothing to disclose because there is
 *     nothing collected;
 *   * the call to action is a link styled as a button, with the same URL repeated
 *     as text underneath, because a stripped button is a dead end and because a
 *     visible URL is what lets a careful reader check where it goes before
 *     clicking (which is the advice the security copy gives);
 *   * `560px` maximum width and a 16px base, which is the width that survives a
 *     phone in portrait without a horizontal scroll.
 */

export interface LayoutInput {
  readonly locale: string;
  readonly heading: string;
  /** One paragraph per entry, already localised and escaped for HTML. */
  readonly paragraphs: readonly string[];
  readonly cta?: { readonly label: string; readonly url: string };
  /** Small print under the rule: expiry notes, "you can ignore this", and so on. */
  readonly footnotes?: readonly string[];
  /** Rendered only for the kinds that allow it (`NON_TRANSACTIONAL_KINDS`). */
  readonly unsubscribe?: { readonly label: string; readonly url: string };
  /** "Sent by Aksharo · support@aksharo.ai", already localised. */
  readonly signoff: string;
}

/** `&`, `<`, `>`, `"` and `'` — the five that matter inside an attribute or a body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A URL safe to put in an `href`.
 *
 * Only `https:` and `http:` survive; anything else — `javascript:`, `data:` — is
 * replaced by the brand's site. Template data reaches here from a job payload,
 * and a job payload is not a place to trust a scheme.
 */
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    /* fall through */
  }
  return `https://${BRAND.domain}/`;
}

const INK = "#101014";
const MUTED = "#5b5b66";
const RULE = "#e4e4ea";
const PAPER = "#f6f6f8";
const ACCENT = "#101014";

export function renderHtml(input: LayoutInput): string {
  const paragraphs = input.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${INK};">${text}</p>`,
    )
    .join("\n            ");

  const cta =
    input.cta === undefined
      ? ""
      : `
            <p style="margin:24px 0 8px;">
              <a href="${escapeHtml(safeUrl(input.cta.url))}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:${ACCENT};color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;">${input.cta.label}</a>
            </p>
            <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${MUTED};word-break:break-all;">${escapeHtml(safeUrl(input.cta.url))}</p>`;

  const footnotes =
    input.footnotes === undefined || input.footnotes.length === 0
      ? ""
      : input.footnotes
          .map(
            (text) =>
              `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${MUTED};">${text}</p>`,
          )
          .join("\n            ");

  const unsubscribe =
    input.unsubscribe === undefined
      ? ""
      : `<p style="margin:8px 0 0;font-size:13px;line-height:1.5;color:${MUTED};"><a href="${escapeHtml(safeUrl(input.unsubscribe.url))}" style="color:${MUTED};">${input.unsubscribe.label}</a></p>`;

  return `<!doctype html>
<html lang="${escapeHtml(input.locale)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(BRAND.name)}</title>
    <style>
      @media only screen and (max-width: 600px) {
        .wrap { padding: 16px !important; }
        .card { padding: 24px 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${PAPER};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
      <tr>
        <td class="wrap" align="center" style="padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans Devanagari',sans-serif;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
            <tr>
              <td style="padding:0 0 16px;font-size:15px;font-weight:700;letter-spacing:0.02em;color:${INK};">${escapeHtml(BRAND.name)}</td>
            </tr>
            <tr>
              <td class="card" style="background:#ffffff;border:1px solid ${RULE};border-radius:12px;padding:32px;">
            <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:${INK};">${input.heading}</h1>
            ${paragraphs}${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 4px 0;">
            ${footnotes}
                <p style="margin:8px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${input.signoff}</p>
                ${unsubscribe}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

/**
 * The text part.
 *
 * Not a stripped copy of the HTML: it is written from the same strings, so it
 * says the same thing in the same order and the URL is on its own line where a
 * terminal client can make it clickable.
 */
export function renderText(input: LayoutInput): string {
  const lines: string[] = [BRAND.name, "", input.heading, ""];
  for (const paragraph of input.paragraphs) lines.push(paragraph, "");
  if (input.cta !== undefined) lines.push(`${input.cta.label}:`, safeUrl(input.cta.url), "");
  if (input.footnotes !== undefined) for (const note of input.footnotes) lines.push(note);
  if (input.footnotes !== undefined && input.footnotes.length > 0) lines.push("");
  lines.push(input.signoff);
  if (input.unsubscribe !== undefined) {
    lines.push(`${input.unsubscribe.label}: ${safeUrl(input.unsubscribe.url)}`);
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

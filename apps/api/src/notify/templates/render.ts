import { IntlMessageFormat } from "intl-messageformat";

import { BRAND } from "@montaj/config";

import { escapeHtml, renderHtml, renderText, safeUrl } from "./layout.js";
import { EN_MESSAGES } from "./messages.en.js";
import { HI_MESSAGES } from "./messages.hi.js";
import { allowsUnsubscribe } from "../notify.kinds.js";

import type { MessageCatalogue } from "./messages.js";
import type { NotifyKind } from "../notify.kinds.js";

/**
 * Turning `(kind, locale, data)` into a subject and two bodies.
 *
 * Two rules hold the whole thing together:
 *
 *   1. **Format, then escape is wrong; escape, then format is right.** Every
 *      value is HTML-escaped *before* ICU sees it for the HTML pass, so a project
 *      called `<b>` becomes `&lt;b&gt;` inside the sentence and the message's own
 *      markup-free text stays markup-free. The text pass formats the same strings
 *      with the raw values.
 *   2. **A missing variable is a bug, not a blank.** ICU throws, and the consumer
 *      turns that into an unrecoverable job: a message that renders "Hi ," is
 *      worse than one that is never sent and shows up in the dead-letter queue.
 */

/** The languages with a catalogue. Everything else falls back to English. */
export const SUPPORTED_LOCALES = ["en", "hi"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const CATALOGUES: Readonly<Record<SupportedLocale, MessageCatalogue>> = Object.freeze({
  en: EN_MESSAGES,
  hi: HI_MESSAGES,
});

/**
 * `hi-IN` → `hi`, `en_US` → `en`, `mr-IN` → `en`.
 *
 * A region is dropped rather than matched: there is one Hindi catalogue and one
 * English one, and pretending otherwise would mean silently ignoring `hi-Latn`.
 */
export function normaliseLocale(locale: string | undefined): SupportedLocale {
  const base = (locale ?? "").trim().toLowerCase().replace(/_/g, "-").split("-")[0] ?? "";
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as SupportedLocale) : "en";
}

export function catalogueFor(locale: string | undefined): MessageCatalogue {
  return CATALOGUES[normaliseLocale(locale)];
}

/** Values a template may interpolate. Dates and money arrive pre-formatted. */
export type TemplateData = Readonly<Record<string, string | number | boolean>>;

export interface RenderedMessage {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly locale: SupportedLocale;
}

/** Thrown when a kind's strings need a variable the caller did not supply. */
export class TemplateRenderError extends Error {
  public override readonly name = "TemplateRenderError";

  constructor(
    readonly kind: NotifyKind,
    readonly locale: string,
    cause: unknown,
  ) {
    super(
      `Could not render "${kind}" in "${locale}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Top-level `{name}` / `{count, plural, ...}` variable names in an ICU string.
 *
 * A regex rather than the ICU parser because the only consumer is the test that
 * proves the English and Hindi catalogues reference the same variables, and that
 * test wants a plain set of names, not an AST.
 */
export function placeholdersIn(message: string): Set<string> {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\s*([A-Za-z][A-Za-z0-9_]*)\s*[,}]/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

/**
 * Compiled messages are cached: `IntlMessageFormat` parses on construction, and
 * the same twenty strings are formatted on every send. The key includes the
 * locale because the same string in two languages compiles to two formatters.
 */
const compiled = new Map<string, IntlMessageFormat>();

function format(locale: string, message: string, values: TemplateData): string {
  // `\u0000` as an escape, never the raw character: the separator has to be
  // something neither half can contain, and a literal NUL in the source makes
  // git classify this file as binary — which costs every future reader a
  // readable diff for one byte nobody can see.
  const key = `${locale}\u0000${message}`;
  let formatter = compiled.get(key);
  if (formatter === undefined) {
    formatter = new IntlMessageFormat(message, locale);
    compiled.set(key, formatter);
  }
  const result = formatter.format(values as Record<string, string | number | boolean>);
  return typeof result === "string" ? result : String(result);
}

/** Test seam: drop the compiled-message cache. */
export function resetTemplateCache(): void {
  compiled.clear();
}

function escapeValues(values: TemplateData): TemplateData {
  const escaped: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(values)) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    escaped[name] = typeof value === "string" ? escapeHtml(value) : value;
  }
  return escaped;
}

export interface RenderInput {
  readonly kind: NotifyKind;
  readonly locale?: string;
  readonly data?: TemplateData;
  /** Where the unsubscribe link points for the kinds that carry one. */
  readonly unsubscribeUrl?: string;
}

/**
 * Render one message.
 *
 * The whole thing is rendered twice — once with escaped values for the HTML and
 * once with raw values for the text — rather than stripping tags out of the HTML
 * afterwards, because a stripped body loses the line breaks that make the text
 * part readable and gains the ones inside the markup.
 */
export function renderNotification(input: RenderInput): RenderedMessage {
  const locale = normaliseLocale(input.locale);
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const catalogue = CATALOGUES[locale];
  const strings = catalogue.kinds[input.kind];

  const values: TemplateData = {
    ...catalogue.defaults,
    brand: BRAND.name,
    support: BRAND.supportEmail,
    ...(input.data ?? {}),
  };
  const htmlValues = escapeValues(values);
  const icu = catalogue.locale;

  try {
    const link = typeof values["link"] === "string" ? values["link"] : undefined;
    const cta =
      strings.cta === undefined || link === undefined
        ? undefined
        : { label: strings.cta, url: link };

    const unsubscribe =
      allowsUnsubscribe(input.kind) && input.unsubscribeUrl !== undefined
        ? { label: catalogue.chrome.unsubscribe, url: input.unsubscribeUrl }
        : undefined;

    const html = renderHtml({
      locale,
      heading: format(icu, strings.heading, htmlValues),
      paragraphs: strings.paragraphs.map((line) => format(icu, line, htmlValues)),
      ...(cta === undefined
        ? {}
        : { cta: { label: escapeHtml(format(icu, cta.label, values)), url: cta.url } }),
      ...(strings.footnotes === undefined
        ? {}
        : { footnotes: strings.footnotes.map((line) => format(icu, line, htmlValues)) }),
      ...(unsubscribe === undefined
        ? {}
        : {
            unsubscribe: {
              label: escapeHtml(format(icu, unsubscribe.label, values)),
              url: unsubscribe.url,
            },
          }),
      signoff: format(icu, catalogue.chrome.signoff, htmlValues),
    });

    const text = renderText({
      locale,
      heading: format(icu, strings.heading, values),
      paragraphs: strings.paragraphs.map((line) => format(icu, line, values)),
      ...(cta === undefined
        ? {}
        : { cta: { label: format(icu, cta.label, values), url: cta.url } }),
      ...(strings.footnotes === undefined
        ? {}
        : { footnotes: strings.footnotes.map((line) => format(icu, line, values)) }),
      ...(unsubscribe === undefined
        ? {}
        : { unsubscribe: { label: format(icu, unsubscribe.label, values), url: unsubscribe.url } }),
      signoff: format(icu, catalogue.chrome.signoff, values),
    });

    return {
      // Subjects are plain text in every client, so this one is never escaped.
      subject: format(icu, strings.subject, values),
      html,
      text,
      locale,
    };
  } catch (error) {
    if (error instanceof TemplateRenderError) throw error;
    throw new TemplateRenderError(input.kind, locale, error);
  }
}

/** Re-exported so callers building a CTA get the same scheme check the layout uses. */
export { safeUrl };

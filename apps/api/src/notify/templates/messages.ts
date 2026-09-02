import type { NotifyKind } from "../notify.kinds.js";

/**
 * The shape of a message catalogue. One per UI language (08 section 6: English
 * and Hindi at launch), every string in ICU MessageFormat.
 *
 * Nothing here contains markup. The strings are content; `layout.ts` is the
 * chrome; the renderer escapes every interpolated value before it reaches the
 * HTML. That split is what makes a translator's file safe to edit and what stops
 * a project name from becoming a tag.
 *
 * Brand words are **not** written into the strings either — they arrive as the
 * `{brand}` and `{support}` variables from `packages/config/src/brand.ts`, which
 * CONTRACTS section 0 names as the only place they may live.
 */
export interface TemplateStrings {
  readonly subject: string;
  readonly heading: string;
  /** One paragraph per entry, in order. */
  readonly paragraphs: readonly string[];
  /** Button label. Kinds with no link omit it. */
  readonly cta?: string;
  /** Small print under the rule: expiry, "if this was not you", and so on. */
  readonly footnotes?: readonly string[];
}

/** Strings shared by every message. */
export interface Chrome {
  readonly signoff: string;
  readonly unsubscribe: string;
}

/**
 * Stand-ins for the variables a caller may legitimately not know.
 *
 * Localised, because "there" and "an unknown location" are copy: a Hindi message
 * that greets someone in English because the name was missing reads worse than
 * one that never had a name at all. Anything NOT in this map is required, and a
 * message that references a missing variable fails the job rather than shipping
 * a half-rendered sentence.
 */
export type TemplateDefaults = Readonly<Record<string, string>>;

export interface MessageCatalogue {
  /** BCP-47 tag passed to ICU, so plural and number rules are the language's own. */
  readonly locale: string;
  readonly chrome: Chrome;
  readonly defaults: TemplateDefaults;
  readonly kinds: Readonly<Record<NotifyKind, TemplateStrings>>;
}

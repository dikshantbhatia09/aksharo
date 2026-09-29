/**
 * A deliberately small XML reader for the one XML document channel automations
 * read: a YouTube channel's Atom feed (2026-10-02).
 *
 * No XML package is installed in this app, and "a full parser, configured not to
 * expand entities" depends on getting every one of its options right. This one
 * cannot expand anything, because it knows nothing to expand:
 *
 *   * a document type declaration (`<!DOCTYPE`) or an entity declaration
 *     (`<!ENTITY`) ANYWHERE refuses the whole document (`dtd_refused`): no
 *     internal subset, no external or parameter entities - so no billion
 *     laughs, no quadratic blow-up and no XXE, by construction;
 *   * text and attribute values decode the five predefined entities and
 *     numeric character references, and nothing else: an unknown `&name;` is
 *     kept exactly as written, never looked up;
 *   * it is one forward pass driven by `indexOf`, bounded in characters,
 *     depth, elements and attributes per element, with no backtracking regular
 *     expression over the document.
 *
 * Namespaces are resolved (`xmlns`, `xmlns:p`), so a caller matches an element
 * by namespace and local name rather than trusting whichever prefix a feed
 * happens to use.
 */

export type XmlErrorCode =
  "dtd_refused" | "malformed" | "too_large" | "too_deep" | "too_many_nodes";

export class XmlParseError extends Error {
  constructor(
    readonly code: XmlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "XmlParseError";
  }
}

export interface XmlElement {
  /** The qualified name as written (`media:group`). */
  readonly name: string;
  readonly local: string;
  /** The namespace its prefix resolves to; null when it has none. */
  readonly ns: string | null;
  /** Attributes by qualified name, values decoded. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The character data directly inside it, decoded, in document order. */
  readonly text: string;
}

export interface XmlLimits {
  readonly maxChars: number;
  readonly maxDepth: number;
  readonly maxElements: number;
  readonly maxAttributes: number;
}

/** Far above a 15-entry feed (tens of KB, a few hundred elements, depth 5). */
export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxChars: 2 * 1024 * 1024,
  maxDepth: 32,
  maxElements: 20_000,
  maxAttributes: 32,
});

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** One part of a name. ASCII only: enough for Atom and Media RSS, and nothing exotic to get wrong. */
const NAME_PART = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `local` or `prefix:local`. */
function isName(value: string): boolean {
  const parts = value.split(":");
  return parts.length <= 2 && parts.every((part) => NAME_PART.test(part));
}

const PREDEFINED: Readonly<Record<string, string>> = Object.freeze({
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
});

/**
 * Decode the five predefined entities and numeric character references. A
 * reference to anything else - including a code point that is not a legal
 * character - is left exactly as it was written.
 */
export function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(
    /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        const legal =
          Number.isInteger(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff) &&
          code !== 0xfffe &&
          code !== 0xffff;
        return legal ? String.fromCodePoint(code) : whole;
      }
      // eslint-disable-next-line security/detect-object-injection -- `body` is one of the five literal names the pattern admits
      return PREDEFINED[body] ?? whole;
    },
  );
}

interface Open {
  readonly name: string;
  readonly local: string;
  readonly ns: string | null;
  readonly attrs: Record<string, string>;
  readonly children: XmlElement[];
  text: string;
  readonly namespaces: ReadonlyMap<string, string | null>;
}

interface Tag {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly selfClosing: boolean;
  /** Index just past the tag's `>`. */
  readonly end: number;
}

function malformed(message: string): XmlParseError {
  return new XmlParseError("malformed", message);
}

function isSpace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

/** Read one start tag whose name begins at `start` (just past the `<`). */
function readTag(input: string, start: number, maxAttributes: number): Tag {
  // `charAt`, not `input[i]`: past the end it is "", which every test below refuses.
  const at = (index: number): string => input.charAt(index);
  let i = start;
  while (i < input.length && !isSpace(at(i)) && at(i) !== ">" && at(i) !== "/") i += 1;
  const name = input.slice(start, i);
  if (!isName(name)) throw malformed("a tag with no valid name");

  const attrs: Record<string, string> = {};
  let count = 0;
  for (;;) {
    while (isSpace(at(i))) i += 1;
    const char = at(i);
    if (char === "") throw malformed("a tag that never closes");
    if (char === ">") return { name, attrs, selfClosing: false, end: i + 1 };
    if (char === "/") {
      if (at(i + 1) !== ">") throw malformed("a stray / in a tag");
      return { name, attrs, selfClosing: true, end: i + 2 };
    }

    const nameStart = i;
    while (i < input.length && !isSpace(at(i)) && at(i) !== "=" && at(i) !== ">") {
      i += 1;
    }
    const attrName = input.slice(nameStart, i);
    if (!isName(attrName)) throw malformed("an attribute with no valid name");
    while (isSpace(at(i))) i += 1;
    if (at(i) !== "=") throw malformed("an attribute with no value");
    i += 1;
    while (isSpace(at(i))) i += 1;
    const quote = at(i);
    if (quote !== '"' && quote !== "'") throw malformed("an unquoted attribute value");
    const close = input.indexOf(quote, i + 1);
    if (close === -1) throw malformed("an attribute value that never closes");
    const raw = input.slice(i + 1, close);
    if (raw.includes("<")) throw malformed("a < inside an attribute value");
    if (Object.hasOwn(attrs, attrName)) throw malformed("a repeated attribute");
    count += 1;
    if (count > maxAttributes) throw malformed("too many attributes on one element");
    // eslint-disable-next-line security/detect-object-injection -- a validated XML name, on an object this function made
    attrs[attrName] = decodeEntities(raw);
    i = close + 1;
    // Attributes are separated by white space; `a="1"b="2"` is not XML.
    if (!isSpace(at(i)) && at(i) !== ">" && at(i) !== "/") {
      throw malformed("attributes with nothing between them");
    }
  }
}

function prefixOf(name: string): { readonly prefix: string; readonly local: string } {
  const colon = name.indexOf(":");
  return colon === -1
    ? { prefix: "", local: name }
    : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

function freeze(open: Open): XmlElement {
  return {
    name: open.name,
    local: open.local,
    ns: open.ns,
    attrs: open.attrs,
    children: open.children,
    text: open.text,
  };
}

/**
 * Parse `input` into its root element.
 *
 * @throws XmlParseError - `dtd_refused` for any DTD or entity declaration,
 *   `too_large` / `too_deep` / `too_many_nodes` past `limits`, `malformed` for
 *   anything else that is not well-formed.
 */
export function parseXml(input: string, limits: Partial<XmlLimits> = {}): XmlElement {
  const max: XmlLimits = { ...DEFAULT_XML_LIMITS, ...limits };
  if (input.length > max.maxChars) {
    throw new XmlParseError("too_large", `more than ${String(max.maxChars)} characters`);
  }
  // Anywhere, not only in the prolog: nothing this reader accepts needs one, and
  // refusing on sight means no code path ever sees a declaration to act on.
  if (/<!DOCTYPE/i.test(input) || /<!ENTITY/i.test(input)) {
    throw new XmlParseError("dtd_refused", "a document type or entity declaration");
  }

  const stack: Open[] = [];
  const topNamespaces: ReadonlyMap<string, string | null> = new Map([["xml", XML_NAMESPACE]]);
  let root: XmlElement | null = null;
  let elements = 0;
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0;

  const addText = (text: string): void => {
    const current = stack[stack.length - 1];
    if (current === undefined) {
      if (text.trim() !== "") throw malformed("text outside the root element");
      return;
    }
    current.text += text;
  };

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    const textEnd = lt === -1 ? input.length : lt;
    if (textEnd > i) addText(decodeEntities(input.slice(i, textEnd)));
    if (lt === -1) break;

    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      if (end === -1) throw malformed("a processing instruction that never closes");
      i = end + 2;
      continue;
    }
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end === -1) throw malformed("a comment that never closes");
      i = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      if (end === -1) throw malformed("a CDATA section that never closes");
      if (stack.length === 0) throw malformed("CDATA outside the root element");
      addText(input.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (input.startsWith("<!", lt)) throw malformed("a declaration this reader does not read");

    if (input.startsWith("</", lt)) {
      const end = input.indexOf(">", lt + 2);
      if (end === -1) throw malformed("an end tag that never closes");
      const name = input.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) throw malformed(`an unexpected </${name}>`);
      const element = freeze(open);
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
      i = end + 1;
      continue;
    }

    const tag = readTag(input, lt + 1, max.maxAttributes);
    if (root !== null) throw malformed("more than one root element");
    elements += 1;
    if (elements > max.maxElements) {
      throw new XmlParseError("too_many_nodes", `more than ${String(max.maxElements)} elements`);
    }
    if (stack.length >= max.maxDepth) {
      throw new XmlParseError("too_deep", `nested deeper than ${String(max.maxDepth)}`);
    }

    const parentNamespaces = stack[stack.length - 1]?.namespaces ?? topNamespaces;
    let namespaces = parentNamespaces;
    for (const [attr, value] of Object.entries(tag.attrs)) {
      if (attr !== "xmlns" && !attr.startsWith("xmlns:")) continue;
      if (namespaces === parentNamespaces) namespaces = new Map(parentNamespaces);
      (namespaces as Map<string, string | null>).set(
        attr === "xmlns" ? "" : attr.slice(6),
        value === "" ? null : value,
      );
    }
    const { prefix, local } = prefixOf(tag.name);
    const open: Open = {
      name: tag.name,
      local,
      ns: namespaces.get(prefix) ?? null,
      attrs: tag.attrs,
      children: [],
      text: "",
      namespaces,
    };
    if (tag.selfClosing) {
      const element = freeze(open);
      const parent = stack[stack.length - 1];
      if (parent === undefined) root = element;
      else parent.children.push(element);
    } else {
      stack.push(open);
    }
    i = tag.end;
  }

  if (stack.length > 0) throw malformed(`<${stack[stack.length - 1]?.name ?? ""}> never closes`);
  if (root === null) throw malformed("no root element");
  return root;
}

/** The first child of `element` with this namespace and local name. */
export function childOf(element: XmlElement, ns: string, local: string): XmlElement | undefined {
  return element.children.find((child) => child.ns === ns && child.local === local);
}

/** Every child of `element` with this namespace and local name. */
export function childrenOf(element: XmlElement, ns: string, local: string): XmlElement[] {
  return element.children.filter((child) => child.ns === ns && child.local === local);
}

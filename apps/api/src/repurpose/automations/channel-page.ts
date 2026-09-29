import { cleanTitle } from "./channel-feed.js";
import { CHANNEL_ID } from "./channel-url.js";
import { decodeEntities } from "./safe-xml.js";

/**
 * A channel's page, read for two facts only (2026-10-02): its `UC…` id and its
 * name. A handle or a legacy name is how a person knows a channel; the id is
 * how its feed is asked for.
 *
 * The page's tags say the id three ways - its canonical link
 * (`/channel/UC…`), its RSS link (`?channel_id=UC…`) and its `og:url` - and
 * they must agree: a page naming two channels there is not a page this reads.
 * The page's data (`"externalId":"UC…"`) is the fallback when the tags say
 * nothing. Nothing on the page is executed or followed; a link it names is a
 * string matched against one pattern.
 */

/**
 * How much of the page the tag scan reads: all of it, up to the reader's own
 * cap (`PAGE_MAX_BYTES`). A real channel page does not keep these tags in its
 * first kilobytes: on 2026-09-29 TED's page carried ~700 KB of inline script
 * first, a `</head>` inside it, and its canonical link, og tags and title at
 * ~752 KB - past both the old 600,000-character scan and that `</head>`, so
 * the name was never found and the id only through the data fallback.
 */
const TAG_SCAN_CHARS = 4 * 1024 * 1024;
const TAG = /<(link|meta)\b([^<>]{0,2000})>/gi;
const ATTRIBUTE = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CHANNEL_PATH =
  /^https:\/\/(?:www\.|m\.)?youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/;
const FEED_QUERY =
  /^https:\/\/(?:www\.)?youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})(?:&|$)/;
const EXTERNAL_ID = /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/;
const TITLE_TAG = /<title\b[^<>]{0,200}>([^<]{0,500})<\/title>/i;

export interface PageChannel {
  readonly channelId: string;
  readonly title: string | null;
}

function attributesOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    // eslint-disable-next-line security/detect-object-injection -- a lower-cased attribute name on an object made here
    if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function titleOf(value: string | undefined): string | null {
  const title = cleanTitle(decodeEntities(value ?? "").replace(/\s+-\s+YouTube$/, ""), 200);
  return title === "" ? null : title;
}

/** The channel a page is about, or null when it does not say, or says two things. */
export function channelFromPage(html: string): PageChannel | null {
  const head = html.slice(0, TAG_SCAN_CHARS);

  const ids = new Set<string>();
  let ogTitle: string | undefined;
  for (const match of head.matchAll(TAG)) {
    const kind = (match[1] ?? "").toLowerCase();
    const attrs = attributesOf(match[2] ?? "");
    const rel = (attrs["rel"] ?? "").toLowerCase();
    if (kind === "link" && rel === "canonical") {
      const id = CHANNEL_PATH.exec(attrs["href"] ?? "")?.[1];
      if (id !== undefined) ids.add(id);
    } else if (kind === "link" && rel === "alternate" && /rss/i.test(attrs["type"] ?? "")) {
      const id = FEED_QUERY.exec(attrs["href"] ?? "")?.[1];
      if (id !== undefined) ids.add(id);
    } else if (kind === "meta") {
      const key = (attrs["property"] ?? attrs["itemprop"] ?? attrs["name"] ?? "").toLowerCase();
      const content = attrs["content"] ?? "";
      if (key === "og:url") {
        const id = CHANNEL_PATH.exec(content)?.[1];
        if (id !== undefined) ids.add(id);
      } else if ((key === "identifier" || key === "channelid") && CHANNEL_ID.test(content)) {
        ids.add(content);
      } else if (key === "og:title" && ogTitle === undefined) {
        ogTitle = content;
      }
    }
  }

  // Two channels in the head is a page this cannot vouch for.
  if (ids.size > 1) return null;
  const channelId = [...ids][0] ?? EXTERNAL_ID.exec(html)?.[1];
  if (channelId === undefined) return null;

  return { channelId, title: titleOf(ogTitle) ?? titleOf(TITLE_TAG.exec(head)?.[1]) };
}

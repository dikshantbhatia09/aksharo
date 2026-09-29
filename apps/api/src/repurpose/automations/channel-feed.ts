import { CHANNEL_ID } from "./channel-url.js";
import { XmlParseError, childOf, childrenOf, parseXml } from "./safe-xml.js";

import type { XmlElement } from "./safe-xml.js";

/**
 * A YouTube channel's public upload feed (2026-10-02),
 * `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`: an Atom document
 * listing its latest ~15 uploads, newest first, each with its video id, title
 * and publication time. Read by `safe-xml.ts`, so a DTD or an entity
 * declaration refuses the document before anything else happens.
 *
 * Two kinds of entry are marked for the poller to leave alone:
 *
 *   * **Shorts.** The feed links a Short to `/shorts/{id}` rather than
 *     `/watch?v={id}`; `#shorts` in the title or description is the older tell.
 *   * **Not watchable yet.** A premiere or live stream that has not happened is
 *     listed with no views (`media:statistics views="0"`). A real upload has
 *     views within the hour, so "no views" is a reason to look again later,
 *     not a verdict (`WATCH_UPCOMING_WAIT_MS`).
 */

const ATOM = "http://www.w3.org/2005/Atom";
const YOUTUBE = "http://www.youtube.com/xml/schemas/2015";
const MEDIA = "http://search.yahoo.com/mrss/";

/** A feed is tens of kilobytes; this is the reader's ceiling, not the fetcher's (1 MiB). */
const FEED_MAX_CHARS = 1024 * 1024;
/** More entries than any feed carries (15), so a strange one cannot fan out a poll. */
const MAX_ENTRIES = 50;
/** Titles are stored and shown; YouTube's own limit is 100 characters. */
const TITLE_MAX = 300;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SHORTS_TAG = /#shorts\b/i;

export interface FeedEntry {
  readonly videoId: string;
  readonly title: string;
  readonly publishedAt: Date;
  /** The entry's own link, as the feed gave it. */
  readonly link: string | null;
  /** A Short: linked to `/shorts/`, or tagged `#shorts`. */
  readonly isShort: boolean;
  /** `media:statistics views`; null when the feed says nothing. */
  readonly views: number | null;
}

export interface ChannelFeed {
  /** The channel the feed says it is, `UC…`; null when it does not say. */
  readonly channelId: string | null;
  readonly title: string | null;
  /** Newest first. */
  readonly entries: readonly FeedEntry[];
}

/** One line, trimmed, bounded: a title as it is stored and shown. */
export function cleanTitle(value: string | undefined, max = TITLE_MAX): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function textOf(element: XmlElement | undefined): string | undefined {
  return element === undefined ? undefined : element.text.trim();
}

/** `UC…` from the feed's own `yt:channelId`, which some feeds write without its `UC`. */
function channelIdOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (CHANNEL_ID.test(raw)) return raw;
  return /^[A-Za-z0-9_-]{22}$/.test(raw) ? `UC${raw}` : null;
}

function linkOf(entry: XmlElement): string | null {
  const links = childrenOf(entry, ATOM, "link");
  const link = links.find((candidate) => (candidate.attrs["rel"] ?? "alternate") === "alternate");
  const href = link?.attrs["href"];
  return href === undefined || href === "" ? null : href;
}

function isShortsLink(link: string | null): boolean {
  if (link === null) return false;
  try {
    return new URL(link).pathname.startsWith("/shorts/");
  } catch {
    return false;
  }
}

function viewsOf(group: XmlElement | undefined): number | null {
  const community = group === undefined ? undefined : childOf(group, MEDIA, "community");
  const statistics = community === undefined ? undefined : childOf(community, MEDIA, "statistics");
  const raw = statistics?.attrs["views"];
  if (raw === undefined || !/^\d{1,15}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function entryOf(entry: XmlElement): FeedEntry | null {
  const fromId = /^yt:video:([A-Za-z0-9_-]{11})$/.exec(textOf(childOf(entry, ATOM, "id")) ?? "");
  const videoId = textOf(childOf(entry, YOUTUBE, "videoId")) ?? fromId?.[1];
  if (videoId === undefined || !VIDEO_ID.test(videoId)) return null;

  const published = Date.parse(textOf(childOf(entry, ATOM, "published")) ?? "");
  if (!Number.isFinite(published)) return null;

  const group = childOf(entry, MEDIA, "group");
  const title = cleanTitle(
    textOf(childOf(entry, ATOM, "title")) ??
      (group === undefined ? undefined : textOf(childOf(group, MEDIA, "title"))),
  );
  const description =
    group === undefined ? "" : (textOf(childOf(group, MEDIA, "description")) ?? "");
  const link = linkOf(entry);
  return {
    videoId,
    title,
    publishedAt: new Date(published),
    link,
    isShort: isShortsLink(link) || SHORTS_TAG.test(title) || SHORTS_TAG.test(description),
    views: viewsOf(group),
  };
}

/**
 * Read a channel feed.
 *
 * @throws XmlParseError - not XML this reader accepts, or not an Atom feed.
 */
export function parseChannelFeed(xml: string): ChannelFeed {
  const root = parseXml(xml, { maxChars: FEED_MAX_CHARS });
  if (root.ns !== ATOM || root.local !== "feed") {
    throw new XmlParseError("malformed", "not an Atom feed");
  }
  const author = childOf(root, ATOM, "author");
  const title =
    cleanTitle(textOf(childOf(root, ATOM, "title"))) ||
    cleanTitle(author === undefined ? undefined : textOf(childOf(author, ATOM, "name")));

  const entries: FeedEntry[] = [];
  for (const element of childrenOf(root, ATOM, "entry")) {
    if (entries.length >= MAX_ENTRIES) break;
    const entry = entryOf(element);
    if (entry !== null && !entries.some((seen) => seen.videoId === entry.videoId)) {
      entries.push(entry);
    }
  }
  entries.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  return {
    channelId: channelIdOf(textOf(childOf(root, YOUTUBE, "channelId"))),
    title: title === "" ? null : title,
    entries,
  };
}

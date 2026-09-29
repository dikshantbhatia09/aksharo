/**
 * "Several links" (2026-10-02): the start form's box of links, one per line,
 * read the way the API will read them - each normalised (`source-link.ts`),
 * checked for being a link at all, and the same video pasted twice counted
 * once - so the person sees every problem, line by line, before anything is
 * sent. The API's own parser still decides each link (`parseSourceUrl`) and
 * answers line by line too; this is a courtesy, not the control.
 */
import { isPlausibleLink, normaliseSourceLink } from "@/components/repurpose/source-link";

/** Links one request may carry (the API's `BULK_MAX_LINKS`). */
export const MAX_LINKS = 20;

export interface LinkLine {
  /** 1-based, as the person counts lines. */
  readonly line: number;
  readonly text: string;
  /** The https link that will be sent; null when this line is not one. */
  readonly link: string | null;
  readonly problem: string | null;
  /** The earlier line with the same video, when this one repeats it. */
  readonly duplicateOf: number | null;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video a YouTube link is, however it was written; undefined for anything else. */
export function youtubeVideoIdOf(link: string): string | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (host === "youtu.be" || host === "www.youtu.be") {
    id = url.pathname.slice(1).split("/")[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? undefined;
    for (const prefix of ["/shorts/", "/live/", "/embed/", "/v/"]) {
      if (url.pathname.startsWith(prefix)) id = url.pathname.slice(prefix.length).split("/")[0];
    }
  }
  return id !== undefined && VIDEO_ID.test(id) ? id : undefined;
}

/** Every non-empty line of the box, read. */
export function linkLinesOf(text: string): LinkLine[] {
  const lines: LinkLine[] = [];
  const firstSeen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const line = index + 1;
    const link = normaliseSourceLink(trimmed);
    if (!isPlausibleLink(link)) {
      lines.push({
        line,
        text: trimmed,
        link: null,
        problem: "This line is not a link.",
        duplicateOf: null,
      });
      return;
    }
    const key = youtubeVideoIdOf(link) ?? link;
    const earlier = firstSeen.get(key);
    if (earlier !== undefined) {
      lines.push({ line, text: trimmed, link, problem: null, duplicateOf: earlier });
      return;
    }
    firstSeen.set(key, line);
    lines.push({ line, text: trimmed, link, problem: null, duplicateOf: null });
  });
  return lines;
}

/** The links to send: each video once, in the order pasted. */
export function linksToSend(lines: readonly LinkLine[]): string[] {
  return lines
    .filter((line) => line.link !== null && line.duplicateOf === null)
    .map((line) => line.link as string);
}

/** What stops the box from being sent, or undefined when it can be. */
export function severalLinksProblem(lines: readonly LinkLine[]): string | undefined {
  const links = linksToSend(lines);
  if (lines.length === 0) return "Paste your YouTube links, one per line.";
  if (lines.some((line) => line.problem !== null)) {
    return "Some lines are not links. Fix or remove them.";
  }
  if (links.length > MAX_LINKS) {
    return `Up to ${String(MAX_LINKS)} videos at a time. Remove ${String(links.length - MAX_LINKS)}.`;
  }
  return undefined;
}

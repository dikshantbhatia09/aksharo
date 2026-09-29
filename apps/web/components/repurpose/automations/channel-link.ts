/**
 * A pasted channel link, made into the https address the API expects
 * (2026-10-02): a scheme-less or http link as `source-link.ts` does it, and a
 * bare `@handle` as the channel it names. The API's own parser
 * (`channel-url.ts`) decides what is a channel; this is a courtesy that says
 * so before a round trip.
 */
import { normaliseSourceLink } from "@/components/repurpose/source-link";

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const CHANNEL_PATH = /^\/(?:@[^/]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)(?:\/|$)/;

export function normaliseChannelLink(raw: string): string {
  const trimmed = raw.trim();
  if (/^@[^\s/]{3,30}$/.test(trimmed)) return `https://www.youtube.com/${trimmed}`;
  return normaliseSourceLink(trimmed);
}

/** Shaped like a channel link on YouTube: a handle, a channel id, or a legacy name. */
export function looksLikeChannelLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && HOSTS.has(url.hostname) && CHANNEL_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

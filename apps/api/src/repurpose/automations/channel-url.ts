/**
 * Channel links (2026-10-02): what a person pastes to connect a YouTube
 * channel, turned into the one thing that is ever fetched for it.
 *
 * A pure function, like `source-url.ts`: no network, no database. It decides;
 * `youtube-http.ts` fetches, and only on `https://www.youtube.com`, whatever
 * the link said. The host a request goes to is never taken from input - only
 * a validated channel id, handle or name is, and each is re-encoded into a
 * path on that one host.
 *
 * Accepted, on `youtube.com`, `www.youtube.com` or `m.youtube.com` over HTTPS:
 *
 *   /@handle             a handle (3-30 letters, digits, `_`, `-`, `.`; any script)
 *   /channel/UC…         a channel id
 *   /c/name              a legacy custom name
 *   /user/name           a legacy user name
 *
 * with anything after the first segment (`/videos`, `/featured`), a query
 * (`?si=…`) or a fragment ignored. Everything else - other hosts, a video
 * link, a playlist, a bare vanity path, a port, credentials - is refused.
 */

/** Hosts a channel link may name. Matched exactly, after the URL parser lower-cases them. */
const CHANNEL_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

/** Paths that are one video, not a channel: the refusal says so. */
const VIDEO_PATHS: readonly string[] = [
  "/watch",
  "/shorts/",
  "/live/",
  "/embed/",
  "/v/",
  "/playlist",
];

/** `UC` and 22 characters of the URL-safe alphabet. */
export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** A handle's characters: letters and marks of any script, digits, `_`, `-`, `.`. */
const HANDLE = /^[\p{L}\p{M}\p{N}_.-]{3,30}$/u;
/** A legacy custom (`/c/`) name. */
const CUSTOM_NAME = /^[\p{L}\p{M}\p{N}_.-]{1,100}$/u;
/** A legacy user name: ASCII only, as they were issued. */
const USER_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export type ChannelRef =
  | { readonly kind: "id"; readonly channelId: string }
  | { readonly kind: "handle"; readonly handle: string }
  | { readonly kind: "custom"; readonly name: string }
  | { readonly kind: "user"; readonly name: string };

export type ChannelUrlRejection =
  | "not_a_url"
  | "not_https"
  | "credentials_in_url"
  | "not_youtube"
  | "video_not_channel"
  | "not_a_channel";

export interface ParsedChannelUrl {
  readonly ref: ChannelRef;
  /**
   * The path on `https://www.youtube.com` to read to learn the channel's id
   * and name: the channel page for a handle or a name, none for an id (its
   * feed says both).
   */
  readonly pagePath: string | null;
  /** A stable key for this reference, for caching what it resolved to. */
  readonly key: string;
}

export type ChannelUrlResult =
  | { readonly ok: true; readonly channel: ParsedChannelUrl }
  | { readonly ok: false; readonly code: ChannelUrlRejection };

function reject(code: ChannelUrlRejection): ChannelUrlResult {
  return { ok: false, code };
}

/**
 * A path segment as text, or null when its percent-encoding is broken or it is
 * only dots: `.` and `..` are path steps, not names, and re-encoded they would
 * point somewhere else on the host.
 */
function decodeSegment(segment: string): string | null {
  try {
    const text = decodeURIComponent(segment).normalize("NFC");
    return /^\.+$/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/**
 * Parse a pasted channel link. Shape, then scheme, then credentials, then
 * host, then path - so nothing is said about a host before the rest passed.
 */
export function parseChannelUrl(raw: string): ChannelUrlResult {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 2_048) return reject("not_a_url");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject("not_a_url");
  }

  // `javascript:`, `data:`, `file:`, plain HTTP: all stop here.
  if (url.protocol !== "https:") return reject("not_https");
  if (url.username !== "" || url.password !== "") return reject("credentials_in_url");
  // `hostname` is already lower-cased and IDNA-encoded by the URL parser, so a
  // look-alike (`www.yоutube.com` with a Cyrillic о) arrives as punycode and
  // matches nothing here. A port other than the default is not a link anyone
  // copies from YouTube (the parser drops an explicit :443 itself).
  if (!CHANNEL_HOSTS.has(url.hostname) || url.port !== "") return reject("not_youtube");

  const path = url.pathname;
  if (VIDEO_PATHS.some((prefix) => path === prefix || path.startsWith(prefix))) {
    return reject("video_not_channel");
  }

  const segments = path.split("/").filter((segment) => segment !== "");
  const [first, second] = segments;
  if (first === undefined) return reject("not_a_channel");

  if (first.startsWith("@")) {
    const handle = decodeSegment(first.slice(1));
    if (handle === null || !HANDLE.test(handle)) return reject("not_a_channel");
    return {
      ok: true,
      channel: {
        ref: { kind: "handle", handle },
        pagePath: `/@${encodeURIComponent(handle)}`,
        key: `handle:${handle.toLowerCase()}`,
      },
    };
  }

  if (second === undefined) return reject("not_a_channel");
  const name = decodeSegment(second);
  if (name === null) return reject("not_a_channel");

  switch (first) {
    case "channel":
      if (!CHANNEL_ID.test(name)) return reject("not_a_channel");
      return {
        ok: true,
        channel: { ref: { kind: "id", channelId: name }, pagePath: null, key: `id:${name}` },
      };
    case "c":
      if (!CUSTOM_NAME.test(name)) return reject("not_a_channel");
      return {
        ok: true,
        channel: {
          ref: { kind: "custom", name },
          pagePath: `/c/${encodeURIComponent(name)}`,
          key: `c:${name.toLowerCase()}`,
        },
      };
    case "user":
      if (!USER_NAME.test(name)) return reject("not_a_channel");
      return {
        ok: true,
        channel: {
          ref: { kind: "user", name },
          pagePath: `/user/${encodeURIComponent(name)}`,
          key: `user:${name.toLowerCase()}`,
        },
      };
    default:
      return reject("not_a_channel");
  }
}

/** The canonical link to a channel, for display and for the run page's "from" line. */
export function channelLink(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

/** The plain sentence each refusal maps to. */
export const CHANNEL_URL_MESSAGES: Readonly<Record<ChannelUrlRejection, string>> = Object.freeze({
  not_a_url: "That does not look like a link. Paste the full address of the channel.",
  not_https: "Links must start with https:// so the connection is secure.",
  credentials_in_url: "Remove the username and password from the link before pasting it.",
  not_youtube: "Paste a YouTube channel link, like youtube.com/@yourchannel.",
  video_not_channel:
    "That link is one video. Paste the channel's link instead, like youtube.com/@yourchannel.",
  not_a_channel:
    "That link is not a channel. Paste a link like youtube.com/@yourchannel or youtube.com/channel/UC….",
});

/**
 * "I posted this" (2026-10-05): a pasted link to a post, read as the platform
 * it is on and the platform's own id for it.
 *
 * Seven platforms, each with the few link shapes its share button and address
 * bar actually produce. What is kept is never the pasted text: the id is
 * checked against the platform's own alphabet, and the link stored and shown
 * is rebuilt from it (`https://www.youtube.com/shorts/<id>`), so tracking
 * parameters (`?si=`, `?igsh=`, `utm_*`), credentials, ports and anything else
 * in the paste are dropped, and a link the page shows can only ever point at
 * the platform it names.
 *
 * `key` is what makes a post one post: `youtube:<id>` whichever of the four
 * YouTube link shapes was pasted, `facebook:video:<id>` for a reel and a watch
 * link of the same video. Nothing here fetches anything: a short link (`vm.
 * tiktok.com`, `fb.watch`, `lnkd.in`, `t.co`) cannot be read without following
 * it, so it is refused with a sentence that says what to paste instead.
 */

export const POST_PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "linkedin",
  "x",
  "facebook",
  "threads",
] as const;
export type PostPlatform = (typeof POST_PLATFORMS)[number];

export function isPostPlatform(value: string): value is PostPlatform {
  return (POST_PLATFORMS as readonly string[]).includes(value);
}

/** What each platform is called in a sentence. */
export const PLATFORM_LABELS: Readonly<Record<PostPlatform, string>> = Object.freeze({
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  x: "X",
  facebook: "Facebook",
  threads: "Threads",
});

export interface ParsedPostLink {
  readonly platform: PostPlatform;
  /** The platform's id for the post, as the key names it: `youtube:dQw4w9WgXcQ`. */
  readonly key: string;
  /** The post's own id (a YouTube video id, an Instagram shortcode, ...). */
  readonly id: string;
  /** The canonical link, rebuilt from the id. */
  readonly url: string;
}

export type PostLinkRefusalCode =
  | "performance/link_invalid"
  | "performance/link_unsupported"
  | "performance/link_not_a_post"
  | "performance/link_short";

export interface PostLinkRefusal {
  readonly refused: PostLinkRefusalCode;
  /** One sentence a person can act on. */
  readonly message: string;
}

export const MAX_LINK_CHARS = 2_048;

const SUPPORTED_SENTENCE =
  "Paste a link to a post on YouTube, Instagram, TikTok, LinkedIn, X, Facebook or Threads.";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,64}$/;
const INSTAGRAM_USER = /^[A-Za-z0-9._]{1,30}$/;
const TIKTOK_USER = /^[A-Za-z0-9._]{1,64}$/;
const DIGITS = /^\d{6,25}$/;
const X_USER = /^[A-Za-z0-9_]{1,15}$/;
const FACEBOOK_PAGE = /^[A-Za-z0-9.-]{1,100}$/;
const FACEBOOK_POST_ID = /^(?:\d{6,25}|pfbid[A-Za-z0-9]{10,100})$/;
const FACEBOOK_SHARE_CODE = /^[A-Za-z0-9_-]{5,40}$/;
const THREADS_USER = /^[A-Za-z0-9._]{1,64}$/;
const THREADS_CODE = /^[A-Za-z0-9_-]{5,64}$/;
const LINKEDIN_URN = /^urn:li:(activity|share|ugcPost):(\d{10,25})$/;
const LINKEDIN_SLUG_ID = /(?:^|[-_])(activity|share|ugcPost)-(\d{10,25})(?:-|$)/;

/** Hosts whose links cannot be read without following them, and whose they are. */
const SHORT_LINK_HOSTS: ReadonlyMap<string, string> = new Map([
  ["vm.tiktok.com", "TikTok"],
  ["vt.tiktok.com", "TikTok"],
  ["fb.watch", "Facebook"],
  ["lnkd.in", "LinkedIn"],
  ["t.co", "X"],
  ["youtube.app.goo.gl", "YouTube"],
]);

function refuse(refused: PostLinkRefusalCode, message: string): PostLinkRefusal {
  return { refused, message };
}

function notAPost(platform: PostPlatform): PostLinkRefusal {
  // eslint-disable-next-line security/detect-object-injection -- a platform from the closed list above
  const label = PLATFORM_LABELS[platform];
  return refuse(
    "performance/link_not_a_post",
    `That ${label} link is not a post. Open the post itself and copy its link.`,
  );
}

function post(platform: PostPlatform, keyId: string, id: string, url: string): ParsedPostLink {
  return { platform, key: `${platform}:${keyId}`, id, url };
}

/** The path's segments, percent-decoded, without empty ones. */
function segmentsOf(url: URL): string[] | null {
  const segments: string[] = [];
  for (const raw of url.pathname.split("/")) {
    if (raw === "") continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  return segments;
}

/** `www.`, `m.`, `mobile.`, `web.` and `mbasic.` are the same site. */
function siteOf(hostname: string): string {
  return hostname.replace(/^(?:www|m|mobile|web|mbasic)\./, "");
}

/** The link as a URL a person could have meant, or null. A missing `https://` is added. */
function urlOf(raw: string): URL | null {
  const text = raw.trim();
  if (text === "" || text.length > MAX_LINK_CHARS || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "" || url.port !== "") return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * The post a pasted link names, or why it cannot be taken.
 */
export function parsePostLink(raw: string): ParsedPostLink | PostLinkRefusal {
  const url = urlOf(raw);
  if (url === null) {
    return refuse("performance/link_invalid", `That is not a link. ${SUPPORTED_SENTENCE}`);
  }
  const host = url.hostname.toLowerCase();
  const shortFor = SHORT_LINK_HOSTS.get(host);
  if (shortFor !== undefined) {
    return refuse(
      "performance/link_short",
      `That is a short ${shortFor} link. Open it, then copy the full address of the post.`,
    );
  }
  const segments = segmentsOf(url);
  if (segments === null) {
    return refuse("performance/link_invalid", `That link could not be read. ${SUPPORTED_SENTENCE}`);
  }

  switch (siteOf(host)) {
    case "youtube.com":
    case "music.youtube.com":
    case "youtu.be":
      return youtube(host, url, segments);
    case "instagram.com":
      return instagram(segments);
    case "tiktok.com":
      return tiktok(segments);
    case "linkedin.com":
      return linkedin(segments);
    case "x.com":
    case "twitter.com":
      return x(segments);
    case "facebook.com":
      return facebook(url, segments);
    case "threads.net":
    case "threads.com":
      return threads(segments);
    default:
      return refuse(
        "performance/link_unsupported",
        `Aksharo cannot follow posts on that site. ${SUPPORTED_SENTENCE}`,
      );
  }
}

export function isRefusal(value: ParsedPostLink | PostLinkRefusal): value is PostLinkRefusal {
  return "refused" in value;
}

function youtube(host: string, url: URL, segments: string[]): ParsedPostLink | PostLinkRefusal {
  const [first, second] = segments;
  let id: string | undefined;
  let short = false;
  if (host === "youtu.be") {
    id = first;
  } else if (first === "shorts") {
    id = second;
    short = true;
  } else if (first === "watch") {
    id = url.searchParams.get("v") ?? undefined;
  } else if (first === "live" || first === "embed" || first === "v") {
    id = second;
  }
  if (id === undefined || !YOUTUBE_ID.test(id)) return notAPost("youtube");
  return post(
    "youtube",
    id,
    id,
    short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
  );
}

const INSTAGRAM_KINDS: ReadonlySet<string> = new Set(["reel", "reels", "p", "tv"]);

function instagram(segments: string[]): ParsedPostLink | PostLinkRefusal {
  // `/reel/<code>/`, or `/<user>/reel/<code>/` as a profile's grid links it.
  let kind = segments[0];
  let code = segments[1];
  if (kind !== undefined && !INSTAGRAM_KINDS.has(kind) && INSTAGRAM_USER.test(kind)) {
    kind = segments[1];
    code = segments[2];
  }
  if (kind === undefined || !INSTAGRAM_KINDS.has(kind) || code === undefined) {
    return notAPost("instagram");
  }
  if (!INSTAGRAM_CODE.test(code)) return notAPost("instagram");
  const path = kind === "p" ? "p" : "reel";
  return post("instagram", code, code, `https://www.instagram.com/${path}/${code}/`);
}

function tiktok(segments: string[]): ParsedPostLink | PostLinkRefusal {
  const [user, kind, id] = segments;
  if (user === "t") {
    return refuse(
      "performance/link_short",
      "That is a short TikTok link. Open it, then copy the full address of the post.",
    );
  }
  if (
    user === undefined ||
    !user.startsWith("@") ||
    !TIKTOK_USER.test(user.slice(1)) ||
    kind !== "video" ||
    id === undefined ||
    !DIGITS.test(id)
  ) {
    return notAPost("tiktok");
  }
  return post("tiktok", id, id, `https://www.tiktok.com/${user}/video/${id}`);
}

function linkedin(segments: string[]): ParsedPostLink | PostLinkRefusal {
  let found: RegExpExecArray | null = null;
  const [first, second, third] = segments;
  if (first === "posts" && second !== undefined) {
    found = LINKEDIN_SLUG_ID.exec(second);
  } else if (first === "feed" && second === "update" && third !== undefined) {
    found = LINKEDIN_URN.exec(third);
  } else if (first === "embed" && second === "feed" && segments[2] === "update") {
    found = LINKEDIN_URN.exec(segments[3] ?? "");
  }
  const kind = found?.[1];
  const id = found?.[2];
  if (kind === undefined || id === undefined) return notAPost("linkedin");
  return post(
    "linkedin",
    `${kind}:${id}`,
    id,
    `https://www.linkedin.com/feed/update/urn:li:${kind}:${id}/`,
  );
}

function x(segments: string[]): ParsedPostLink | PostLinkRefusal {
  const [first, second, third, fourth] = segments;
  let user: string | null = null;
  let id: string | undefined;
  if (first === "i" && second === "web" && third === "status") {
    id = fourth;
  } else if (first === "i" && second === "status") {
    id = third;
  } else if (first !== undefined && X_USER.test(first) && second === "status") {
    user = first;
    id = third;
  }
  if (id === undefined || !DIGITS.test(id)) return notAPost("x");
  return post(
    "x",
    id,
    id,
    user === null ? `https://x.com/i/status/${id}` : `https://x.com/${user}/status/${id}`,
  );
}

function facebookVideo(id: string, reel: boolean): ParsedPostLink {
  return post(
    "facebook",
    `video:${id}`,
    id,
    reel ? `https://www.facebook.com/reel/${id}` : `https://www.facebook.com/watch/?v=${id}`,
  );
}

function facebook(url: URL, segments: string[]): ParsedPostLink | PostLinkRefusal {
  const [first, second, third, fourth] = segments;
  // A reel is a video, by the same id.
  if (first === "reel" && second !== undefined && DIGITS.test(second)) {
    return facebookVideo(second, true);
  }
  if (first === "watch" || first === "video.php") {
    const id = url.searchParams.get("v");
    if (id !== null && DIGITS.test(id)) return facebookVideo(id, false);
    return notAPost("facebook");
  }
  if (first === "share" && (second === "v" || second === "r" || second === "p")) {
    if (third === undefined || !FACEBOOK_SHARE_CODE.test(third)) return notAPost("facebook");
    return post(
      "facebook",
      `share:${third}`,
      third,
      `https://www.facebook.com/share/${second}/${third}/`,
    );
  }
  if (first === "permalink.php" || first === "story.php") {
    const id = url.searchParams.get("story_fbid");
    const owner = url.searchParams.get("id");
    if (id === null || !FACEBOOK_POST_ID.test(id) || owner === null || !DIGITS.test(owner)) {
      return notAPost("facebook");
    }
    return post(
      "facebook",
      `post:${id}`,
      id,
      `https://www.facebook.com/permalink.php?story_fbid=${id}&id=${owner}`,
    );
  }
  if (first !== undefined && FACEBOOK_PAGE.test(first)) {
    // `/<page>/videos/<id>` or `/<page>/videos/<title>/<id>`.
    if (second === "videos") {
      const id = fourth !== undefined && DIGITS.test(fourth) ? fourth : third;
      if (id !== undefined && DIGITS.test(id)) return facebookVideo(id, false);
      return notAPost("facebook");
    }
    if (second === "posts" && third !== undefined && FACEBOOK_POST_ID.test(third)) {
      return post(
        "facebook",
        `post:${third}`,
        third,
        `https://www.facebook.com/${first}/posts/${third}`,
      );
    }
  }
  return notAPost("facebook");
}

function threads(segments: string[]): ParsedPostLink | PostLinkRefusal {
  const [user, kind, code] = segments;
  if (
    user === undefined ||
    !user.startsWith("@") ||
    !THREADS_USER.test(user.slice(1)) ||
    kind !== "post" ||
    code === undefined ||
    !THREADS_CODE.test(code)
  ) {
    return notAPost("threads");
  }
  return post("threads", code, code, `https://www.threads.com/${user}/post/${code}`);
}

/**
 * The key a post made through Postiz is filed under: the platform's own, when
 * Postiz said its link and the link reads as a post of that platform, so a
 * later paste of the same link is the same post; else Postiz's own id.
 */
export function postizPostKey(
  platform: PostPlatform,
  externalUrl: string | null,
  externalPostId: string,
): { readonly key: string; readonly url: string | null } {
  if (externalUrl !== null) {
    const parsed = parsePostLink(externalUrl);
    if (!isRefusal(parsed) && parsed.platform === platform) {
      return { key: parsed.key, url: parsed.url };
    }
  }
  return { key: `postiz:${externalPostId}`, url: null };
}

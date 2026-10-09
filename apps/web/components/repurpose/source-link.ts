/**
 * The link a person pasted, made into the https address the API expects.
 *
 * People paste `youtube.com/watch?v=…` from an address bar that hides the
 * scheme, `http://…` from an old bookmark, or a whole share sheet ("Watch this
 * https://youtu.be/…"). `/repurpose` and Home deliberately accept all of those
 * and hand them here — and this form then refused every one with "Links must
 * start with https://" (clips hardening, 2026-09-26). So the form normalises
 * first and validates the result.
 *
 * This is a courtesy, not the control: the API's own parser (`parseSourceUrl`)
 * still decides what is acceptable, and refuses anything that is not https.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
const HOST_WITH_TLD = /^[^\s:@]+\.[a-z]{2,}$/i;

/**
 * Something shaped like `host.tld` or `host.tld/path`, with or without a scheme
 * and a port. Taken apart step by step rather than as one pattern: a single
 * regular expression for it nests quantifiers, and backtracks badly on a long
 * paste.
 */
function looksLikeLink(token: string): boolean {
  let rest = token;
  const schemeEnd = token.indexOf("://");
  if (schemeEnd !== -1) {
    if (!SCHEME.test(token.slice(0, schemeEnd))) return false;
    rest = token.slice(schemeEnd + "://".length);
  }
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  const colon = authority.indexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  const port = colon === -1 ? "" : authority.slice(colon + 1);
  if (colon !== -1 && !/^\d{1,5}$/.test(port)) return false;
  return HOST_WITH_TLD.test(host);
}

function stripWrapping(token: string): string {
  return token.replace(/^[<("'[]+/, "").replace(/[>)"'\].,;!]+$/, "");
}

export function normaliseSourceLink(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  // A share sheet's text: the first word that looks like a link is the link.
  const token =
    trimmed
      .split(/\s+/)
      .map(stripWrapping)
      .find((word) => looksLikeLink(word)) ?? trimmed;
  if (/^https:\/\//i.test(token)) return `https://${token.slice("https://".length)}`;
  if (/^http:\/\//i.test(token)) return `https://${token.slice("http://".length)}`;
  // Any other scheme is left alone for the validator to refuse by name.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return token;
  return looksLikeLink(token) ? `https://${token}` : token;
}

/** Is the normalised link something worth sending to the API at all? */
export function isPlausibleLink(normalised: string): boolean {
  if (!normalised.startsWith("https://")) return false;
  try {
    const url = new URL(normalised);
    return url.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * The feature flag that lets a workspace start clips from a Vimeo, Google
 * Drive or Dropbox link (2026-10-01), on top of `source_youtube_acquire`.
 */
export const HOSTED_SITES_FLAG = "source_hosted_acquire";

/** The video sites a clips run may start from a link on. */
export type LinkSite = "youtube" | "vimeo" | "gdrive" | "dropbox" | "twitch" | "kick";

/**
 * The hosts each site is recognised on: the API's lists in
 * `apps/api/src/repurpose/source-url.ts`, matched exactly after lower-casing,
 * so `vimeo.com.example.test` is not Vimeo.
 */
const SITE_HOSTS: ReadonlyMap<string, LinkSite> = new Map<string, LinkSite>([
  ["youtube.com", "youtube"],
  ["www.youtube.com", "youtube"],
  ["m.youtube.com", "youtube"],
  ["music.youtube.com", "youtube"],
  ["youtube-nocookie.com", "youtube"],
  ["www.youtube-nocookie.com", "youtube"],
  ["youtu.be", "youtube"],
  ["www.youtu.be", "youtube"],
  ["twitch.tv", "twitch"],
  ["www.twitch.tv", "twitch"],
  ["m.twitch.tv", "twitch"],
  ["kick.com", "kick"],
  ["www.kick.com", "kick"],
  ["vimeo.com", "vimeo"],
  ["www.vimeo.com", "vimeo"],
  ["player.vimeo.com", "vimeo"],
  ["drive.google.com", "gdrive"],
  ["dropbox.com", "dropbox"],
  ["www.dropbox.com", "dropbox"],
]);

/**
 * Which video site a normalised link is on, by its host alone; null for any
 * other host or for something that is not a link. Like the rest of this file
 * it is a courtesy: the API still decides whether the path is one video.
 */
export function linkSite(normalised: string): LinkSite | null {
  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return SITE_HOSTS.get(url.hostname.toLowerCase()) ?? null;
}

/** Whether a link is on a dedicated livestream platform (Twitch, Kick) or YouTube Live. */
export function isLivestreamLink(normalised: string): boolean {
  const site = linkSite(normalised);
  if (site === "twitch" || site === "kick") return true;
  if (site === "youtube") {
    try {
      const url = new URL(normalised);
      return url.pathname.startsWith("/live/") || url.searchParams.has("v");
    } catch {
      return false;
    }
  }
  return false;
}

/** The plain words for which links this workspace can use. */
export function linkSitesPhrase(otherSites: boolean): string {
  return otherSites ? "A YouTube, Vimeo, Google Drive or Dropbox link" : "A YouTube link";
}

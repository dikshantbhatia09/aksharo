/**
 * REP-009: the source URL parser and normaliser.
 *
 * A pure function with no network, no process, no database — which is what makes
 * it testable against the injection and property corpus master plan §9.5 asks
 * for. It answers one question: what kind of source is this string, and what is
 * its stable identity?
 *
 * What it deliberately does NOT do:
 *
 *   * it does not fetch anything. Deciding and doing are separate so that a
 *     malformed URL is refused before any socket is opened;
 *   * it does not widen `source-url-ingest.service.ts`. That service fetches a
 *     DIRECT media URL and correctly refuses anything whose content type is not
 *     media. A YouTube watch page is HTML, so it goes to the Wave 3 acquisition
 *     worker instead — teaching the safe fetcher to accept HTML would turn a
 *     narrow media fetcher into a general web client (§9.1);
 *   * it does not accept a playlist as a source. One run is one video.
 *
 * Nothing here is reachable while `source_youtube_acquire` is off, and no
 * acquisition worker exists yet: this is the normaliser Wave 3 will call.
 */

/** Hosts we recognise as YouTube. Matched exactly, after lower-casing. */
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** The short-link hosts, whose whole path is the video id. */
const YOUTUBE_SHORT_HOSTS: ReadonlySet<string> = new Set(["youtu.be", "www.youtu.be"]);

/** Path prefixes that carry a video id in the next segment. */
const YOUTUBE_ID_PATHS = ["/shorts/", "/embed/", "/live/", "/v/"] as const;

/** A YouTube video id: exactly 11 characters of the URL-safe alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * File extensions we will send to the existing safe direct-media fetcher.
 *
 * The extension is only a routing hint: `source-url-ingest.service.ts` still
 * refuses anything whose actual `Content-Type` is not in
 * `SOURCE_URL_ALLOWED_CONTENT_TYPES`, and the media pipeline still probes the
 * bytes. A liar gets a friendly media error, not an import.
 */
const DIRECT_MEDIA_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".m4a",
  ".mp3",
  ".wav",
  ".aac",
  ".ogg",
] as const;

export type SourceRejectionCode =
  | "not_a_url"
  | "not_https"
  | "credentials_in_url"
  | "playlist_not_supported"
  | "missing_video_id"
  | "unsupported_source";

export interface NormalisedSource {
  readonly kind: "youtube_url" | "direct_media_url";
  /** Canonical, parameter-stripped URL. Never the string the user pasted. */
  readonly normalizedUrl: string;
  /**
   * Stable identity for deduplication: `youtube:{videoId}` for YouTube, or
   * `url:{origin}{pathname}` for a direct media file. Long and short YouTube
   * forms of the same video produce the SAME fingerprint, which is what makes
   * "ten pastes are one download" true (§9.5).
   */
  readonly sourceFingerprint: string;
  /** Safe to render: host plus, for YouTube, the video id. No query string. */
  readonly display: string;
}

export type SourceParseResult =
  | { readonly ok: true; readonly source: NormalisedSource }
  | { readonly ok: false; readonly code: SourceRejectionCode };

function reject(code: SourceRejectionCode): SourceParseResult {
  return { ok: false, code };
}

/**
 * Parse and normalise a pasted source URL.
 *
 * The order of the checks matters: shape, then scheme, then credentials, then
 * provider. A caller must never learn that a host exists by being told something
 * else about it first.
 */
export function parseSourceUrl(raw: string): SourceParseResult {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 2_048) return reject("not_a_url");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject("not_a_url");
  }

  // HTTPS only. `javascript:`, `file:`, `data:` and plain HTTP all stop here.
  if (url.protocol !== "https:") return reject("not_https");

  // `https://user:pass@host/` is how a credential ends up in a log line, and how
  // a parser that reads the wrong component ends up talking to the wrong host.
  if (url.username !== "" || url.password !== "") return reject("credentials_in_url");

  const host = url.hostname.toLowerCase();

  if (YOUTUBE_SHORT_HOSTS.has(host)) {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return youtubeResult(id);
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const path = url.pathname;

    // A playlist is a collection. The MVP imports one video, and silently taking
    // its first entry would be a different thing from what was asked for.
    if (path === "/playlist" || (path === "/watch" && url.searchParams.get("v") === null)) {
      return reject(url.searchParams.get("list") === null ? "missing_video_id" : "playlist_not_supported");
    }

    if (path === "/watch") return youtubeResult(url.searchParams.get("v") ?? "");

    for (const prefix of YOUTUBE_ID_PATHS) {
      if (path.startsWith(prefix)) {
        return youtubeResult(path.slice(prefix.length).split("/")[0] ?? "");
      }
    }

    // A channel page, a search, a user profile: recognisable host, but not a
    // video. Refusing with a clear code beats guessing (§9.2 step 6).
    return reject("missing_video_id");
  }

  const lowerPath = url.pathname.toLowerCase();
  if (DIRECT_MEDIA_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))) {
    // Query strings on a direct media URL are usually a signature, so they are
    // kept in `normalizedUrl` — but never in the fingerprint or the display
    // form, where an expiring token has no business being.
    return {
      ok: true,
      source: {
        kind: "direct_media_url",
        normalizedUrl: url.toString(),
        sourceFingerprint: `url:${url.origin}${url.pathname}`,
        display: `${url.hostname}${url.pathname}`,
      },
    };
  }

  return reject("unsupported_source");
}

function youtubeResult(candidate: string): SourceParseResult {
  const id = candidate.trim();
  if (!VIDEO_ID.test(id)) return reject("missing_video_id");
  return {
    ok: true,
    source: {
      kind: "youtube_url",
      // Canonical form: one host, one parameter, nothing that tracks anybody.
      normalizedUrl: `https://www.youtube.com/watch?v=${id}`,
      sourceFingerprint: `youtube:${id}`,
      display: `youtube.com · ${id}`,
    },
  };
}

/** The plain sentence each rejection maps to (§13.4: never a raw parser error). */
export const SOURCE_REJECTION_MESSAGES: Readonly<Record<SourceRejectionCode, string>> =
  Object.freeze({
    not_a_url: "That does not look like a link. Paste the full address of the video.",
    not_https: "Links must start with https:// so the connection is secure.",
    credentials_in_url: "Remove the username and password from the link before pasting it.",
    playlist_not_supported: "Paste a link to one video rather than a playlist.",
    missing_video_id: "That link does not point to a single video.",
    unsupported_source:
      "We can use a YouTube link or a direct video file link. For anything else, upload the video.",
  });

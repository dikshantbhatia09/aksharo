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
 * Nothing here is reachable while `source_youtube_acquire` is off.
 *
 * ## Other video sites (2026-10-01, OpusClip parity)
 *
 * A PUBLIC Vimeo video, Google Drive file or Dropbox file is a `hosted_url`:
 * the same acquisition worker fetches it through yt-dlp's own extractor for
 * that site, pinned with `--use-extractors` so the generic extractor (which
 * follows a redirect anywhere) never runs. What keeps this from being "any
 * address" is the same thing that keeps YouTube from being one:
 *
 *   * a fixed allow-list of hosts, matched exactly after lower-casing
 *     (`vimeo.com.evil.test` is `evil.test`), and one path shape per host;
 *   * the address handed on is REBUILT from the ids taken out of that shape
 *     ({@link hostedUrlOf}), never the string that was pasted, and the same
 *     function rebuilds it from the fingerprint for a retry - so the two can
 *     never disagree;
 *   * the worker re-checks the rebuilt address against its own copy of the
 *     shapes (`assertHostedUrl` in worker-media's `acquire.ts`), which accepts
 *     only the canonical addresses this module writes.
 *
 * Fingerprints: `vimeo:{id}` (`vimeo:{id}/{hash}` for an unlisted video's
 * link), `gdrive:{fileId}`, and `dropbox:s/{key}/{name}` or
 * `dropbox:scl/fi/{id}/{name}?rlkey={key}`. A Dropbox `rlkey` is part of the
 * fingerprint because the link does not open without it, and a retry has
 * nothing else to rebuild the address from (the run never keeps the URL,
 * §17.4). It is a share capability, as an unlisted Vimeo hash or a Drive
 * file id is: the person pasted it to have it fetched. It is kept out of
 * {@link NormalisedSource.display}. A Drive `resourcekey` (files shared before
 * 2021) is not carried, so such a file reads as private.
 *
 * Because a hosted fingerprint can carry a share secret (the `rlkey`, an
 * unlisted Vimeo hash, a Drive file id), it is never written to the audit log
 * or a log line as it is: {@link redactedFingerprint} gives the site and a
 * short hash instead.
 *
 * Known limit: one unlisted Vimeo video can have two fingerprints. Its share
 * link gives `vimeo:{id}/{hash}`, while the same video reached through a
 * channel or group page (`/channels/{name}/{id}`, which carries no hash) gives
 * `vimeo:{id}`. They are not folded into one: the hash is the only thing that
 * opens an unlisted video, so dropping it from the fingerprint would leave a
 * retry with no address that works, and keeping it on `vimeo:{id}` is not
 * possible from a link that never had it. The cost is that the duplicate
 * check (`repurpose_runs_live_source_idx`) does not see the two as one video:
 * pasting both starts two runs and two downloads. A channel link to an
 * unlisted video is rare (the video has to be added to a channel), and the
 * worst outcome is a second download, not a wrong one.
 *
 * These are only accepted while the `source_hosted_acquire` flag is on too
 * (`RepurposeService.resolveSource`, and `RepurposeService.reacquire` for
 * every later fetch).
 */

import { createHash } from "node:crypto";

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

/** Vimeo's hosts. `player.vimeo.com` carries `/video/{id}`; the others `/{id}`. */
const VIMEO_HOSTS: ReadonlySet<string> = new Set(["vimeo.com", "www.vimeo.com"]);
const VIMEO_PLAYER_HOST = "player.vimeo.com";
/** A Vimeo video id: digits only. */
const VIMEO_ID = /^\d{1,15}$/;
/** An unlisted Vimeo video's hash: ten lower-case hex digits (yt-dlp's `unlisted_hash`). */
const VIMEO_HASH = /^[0-9a-f]{10}$/;
/** Vimeo paths that are collections, not one video. */
const VIMEO_COLLECTIONS = ["/showcase/", "/album/", "/channels/", "/groups/"] as const;

/** Google Drive's one host. Docs, Sheets and the rest are never video. */
const DRIVE_HOST = "drive.google.com";
/** A Drive file id. yt-dlp's extractor wants at least 28 characters. */
const DRIVE_ID = /^[A-Za-z0-9_-]{28,100}$/;

const DROPBOX_HOSTS: ReadonlySet<string> = new Set(["dropbox.com", "www.dropbox.com"]);
/** A Dropbox share key or `scl/fi` file id. */
const DROPBOX_ID = /^[A-Za-z0-9_-]{5,40}$/;
/** The `rlkey` an `scl/fi` link needs to open. */
const DROPBOX_RLKEY = /^[A-Za-z0-9]{5,40}$/;
/**
 * A Dropbox file name as it sits in the path, re-encoded by
 * `encodeURIComponent`: what that function leaves alone, plus its escapes.
 */
const DROPBOX_NAME = /^[A-Za-z0-9_.!~*'()%-]{1,95}$/;

/**
 * The contract's longest `sourceId` (`MediaAcquirePayloadSchema`). A
 * fingerprint over it could not be fetched, so it is refused here.
 */
const MAX_FINGERPRINT_LENGTH = 200;

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
  | "link_too_long"
  | "unsupported_source";

/** The other video sites a `hosted_url` may be on (2026-10-01). */
export type HostedSite = "vimeo" | "gdrive" | "dropbox";

export interface NormalisedSource {
  readonly kind: "youtube_url" | "hosted_url" | "direct_media_url";
  /** Canonical, parameter-stripped URL. Never the string the user pasted. */
  readonly normalizedUrl: string;
  /**
   * Stable identity for deduplication: `youtube:{videoId}` for YouTube,
   * `vimeo:`/`gdrive:`/`dropbox:` for another video site (see the module
   * comment), or `url:{origin}{pathname}` for a direct media file. Long and short YouTube
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
      return reject(
        url.searchParams.get("list") === null ? "missing_video_id" : "playlist_not_supported",
      );
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

  if (VIMEO_HOSTS.has(host) || host === VIMEO_PLAYER_HOST) return vimeoSource(host, url);
  if (host === DRIVE_HOST) return driveSource(url);
  if (DROPBOX_HOSTS.has(host)) return dropboxSource(url);

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

/**
 * A Vimeo link: `vimeo.com/{id}`, `vimeo.com/{id}/{hash}` (an unlisted
 * video's share link), `player.vimeo.com/video/{id}[?h={hash}]`, or a video
 * inside a channel or group (`/channels/{name}/{id}`,
 * `/groups/{name}/videos/{id}`). A showcase, album, channel or group page on
 * its own is a collection, refused the way a playlist is.
 */
function vimeoSource(host: string, url: URL): SourceParseResult {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (host === VIMEO_PLAYER_HOST) {
    if (segments.length !== 2 || segments[0] !== "video") return reject("missing_video_id");
    const hash = url.searchParams.get("h");
    return hostedResult({
      site: "vimeo",
      id: segments[1] ?? "",
      ...(hash === null ? {} : { hash }),
    });
  }
  const lower = url.pathname.toLowerCase();
  if (VIMEO_COLLECTIONS.some((prefix) => lower.startsWith(prefix))) {
    const last = segments.at(-1) ?? "";
    const inChannel = lower.startsWith("/channels/") && segments.length === 3;
    const inGroup =
      lower.startsWith("/groups/") && segments.length === 4 && segments[2] === "videos";
    if ((inChannel || inGroup) && VIMEO_ID.test(last)) {
      return hostedResult({ site: "vimeo", id: last });
    }
    return reject("playlist_not_supported");
  }
  if (segments.length === 1) return hostedResult({ site: "vimeo", id: segments[0] ?? "" });
  if (segments.length === 2 && VIMEO_ID.test(segments[0] ?? "")) {
    return hostedResult({ site: "vimeo", id: segments[0] ?? "", hash: segments[1] ?? "" });
  }
  // A profile, a search, the home page: the host, but not a video.
  return reject("missing_video_id");
}

/** A Google Drive file: `/file/d/{id}/...`, `/open?id={id}` or `/uc?id={id}`. */
function driveSource(url: URL): SourceParseResult {
  const path = url.pathname;
  if (path.includes("/folders/")) return reject("playlist_not_supported");
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments[0] === "file" && segments[1] === "d") {
    return hostedResult({ site: "gdrive", id: segments[2] ?? "" });
  }
  if (path === "/open" || path === "/uc") {
    return hostedResult({ site: "gdrive", id: url.searchParams.get("id") ?? "" });
  }
  return reject("missing_video_id");
}

/** A Dropbox file: `/s/{key}/{name}` or `/scl/fi/{id}/{name}?rlkey={key}`. */
function dropboxSource(url: URL): SourceParseResult {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  // `/sh/` and `/scl/fo/` are shared folders.
  if (segments[0] === "sh" || (segments[0] === "scl" && segments[1] === "fo")) {
    return reject("playlist_not_supported");
  }
  if (segments[0] === "s" && segments.length === 3) {
    return hostedResult({ site: "dropbox", id: segments[1] ?? "", name: segments[2] ?? "" });
  }
  if (segments[0] === "scl" && segments[1] === "fi" && segments.length === 4) {
    return hostedResult({
      site: "dropbox",
      id: segments[2] ?? "",
      name: segments[3] ?? "",
      rlkey: url.searchParams.get("rlkey") ?? "",
    });
  }
  return reject("missing_video_id");
}

/** What a hosted link is made of, before it is checked. */
interface HostedParts {
  readonly site: HostedSite;
  readonly id: string;
  /** Vimeo: an unlisted video's hash. */
  readonly hash?: string;
  /** Dropbox: the file name, as it sits in the path. */
  readonly name?: string;
  /** Dropbox `scl/fi`: the link's key. Absent for an `/s/` link. */
  readonly rlkey?: string;
}

/**
 * The `{ok}` result for a hosted link's parts: checked, re-encoded, and made
 * into the fingerprint, the address and the display form - the address from
 * the fingerprint ({@link hostedUrlOf}), exactly as a retry will rebuild it.
 */
function hostedResult(parts: HostedParts): SourceParseResult {
  const fingerprint = hostedFingerprint(parts);
  if (typeof fingerprint !== "string") return reject(fingerprint.code);
  if (fingerprint.length > MAX_FINGERPRINT_LENGTH) return reject("link_too_long");
  const normalizedUrl = hostedUrlOf(fingerprint);
  // Unreachable: every fingerprint built here is one `hostedUrlOf` reads.
  if (normalizedUrl === null) return reject("missing_video_id");
  return {
    ok: true,
    source: {
      kind: "hosted_url",
      normalizedUrl,
      sourceFingerprint: fingerprint,
      display: hostedDisplay(parts),
    },
  };
}

function hostedFingerprint(parts: HostedParts): string | { readonly code: SourceRejectionCode } {
  const invalid = { code: "missing_video_id" as const };
  if (parts.site === "vimeo") {
    if (!VIMEO_ID.test(parts.id)) return invalid;
    if (parts.hash === undefined) return `vimeo:${parts.id}`;
    return VIMEO_HASH.test(parts.hash) ? `vimeo:${parts.id}/${parts.hash}` : invalid;
  }
  if (parts.site === "gdrive") return DRIVE_ID.test(parts.id) ? `gdrive:${parts.id}` : invalid;
  if (!DROPBOX_ID.test(parts.id)) return invalid;
  const name = reencodedName(parts.name ?? "");
  if (name === null) return invalid;
  if (!DROPBOX_NAME.test(name)) return { code: "link_too_long" };
  if (parts.rlkey === undefined) return `dropbox:s/${parts.id}/${name}`;
  // An `scl/fi` link without its key does not open: not a video we can fetch.
  return DROPBOX_RLKEY.test(parts.rlkey)
    ? `dropbox:scl/fi/${parts.id}/${name}?rlkey=${parts.rlkey}`
    : invalid;
}

/** Characters a Dropbox file name may not carry: path separators and control characters. */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const NOT_ONE_SEGMENT = /[/\\\u0000-\u001f\u007f]/;

/**
 * A Dropbox file name segment in one canonical spelling: decoded, checked for
 * anything that could make it more than one path segment, and encoded again
 * with `encodeURIComponent`. Null for a name that is not one plain segment.
 */
function reencodedName(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (
    decoded.trim() === "" ||
    decoded === "." ||
    decoded === ".." ||
    NOT_ONE_SEGMENT.test(decoded)
  ) {
    return null;
  }
  return encodeURIComponent(decoded);
}

/** Safe to render: the site, and the video id or file name. Never a key. */
function hostedDisplay(parts: HostedParts): string {
  if (parts.site === "vimeo") {
    // An unlisted video's hash stays out, and so does the plain form the web
    // rebuilds a public video's link from (`linkFromSourceDisplay`): without
    // its hash, an unlisted video's link does not open.
    return parts.hash === undefined
      ? `vimeo.com · ${parts.id}`
      : `vimeo.com · ${parts.id} (unlisted)`;
  }
  if (parts.site === "gdrive") {
    // The id is the file's share capability: shortened, never shown whole.
    return `Google Drive · ${parts.id.slice(0, 6)}…`;
  }
  // Checked by `reencodedName` before this is reached, so it decodes.
  return `Dropbox · ${decodeURIComponent(parts.name ?? "")}`.slice(0, 160);
}

const VIMEO_FINGERPRINT = /^vimeo:(\d{1,15})$/;
const VIMEO_UNLISTED_FINGERPRINT = /^vimeo:(\d{1,15})\/([0-9a-f]{10})$/;
const DRIVE_FINGERPRINT = /^gdrive:([A-Za-z0-9_-]{28,100})$/;
const DROPBOX_S_FINGERPRINT = /^dropbox:s\/([A-Za-z0-9_-]{5,40})\/([A-Za-z0-9_.!~*'()%-]{1,95})$/;
const DROPBOX_SCL_FINGERPRINT =
  /^dropbox:scl\/fi\/([A-Za-z0-9_-]{5,40})\/([A-Za-z0-9_.!~*'()%-]{1,95})\?rlkey=([A-Za-z0-9]{5,40})$/;

/**
 * The address a hosted link's fingerprint stands for - the only address a
 * `hosted_url` is ever fetched from, at creation and on every retry. Null for
 * anything that is not exactly one of the shapes this module writes.
 *
 * Exported for the service and the reconciler, which rebuild a link from the
 * run's fingerprint when no earlier job is left to read it from.
 */
export function hostedUrlOf(fingerprint: string): string | null {
  const vimeo = VIMEO_FINGERPRINT.exec(fingerprint);
  // The embedded player's address (2026-10-01): yt-dlp's Vimeo "web" client
  // now needs a signed-in account for `vimeo.com/{id}` and its "android"
  // client only cached tokens, while `player.vimeo.com/video/{id}` (plus
  // `?h=` for an unlisted video) is fetched without one - checked live.
  if (vimeo !== null) return `https://player.vimeo.com/video/${vimeo[1] ?? ""}`;
  const unlisted = VIMEO_UNLISTED_FINGERPRINT.exec(fingerprint);
  if (unlisted !== null) {
    return `https://player.vimeo.com/video/${unlisted[1] ?? ""}?h=${unlisted[2] ?? ""}`;
  }
  const drive = DRIVE_FINGERPRINT.exec(fingerprint);
  if (drive !== null) return `https://drive.google.com/file/d/${drive[1] ?? ""}/view`;
  const shared = DROPBOX_S_FINGERPRINT.exec(fingerprint);
  if (shared !== null) {
    return `https://www.dropbox.com/s/${shared[1] ?? ""}/${shared[2] ?? ""}`;
  }
  const file = DROPBOX_SCL_FINGERPRINT.exec(fingerprint);
  if (file !== null) {
    const [, id = "", name = "", rlkey = ""] = file;
    return `https://www.dropbox.com/scl/fi/${id}/${name}?rlkey=${rlkey}`;
  }
  return null;
}

/**
 * The address a link run fetches, rebuilt from its kind and fingerprint: a
 * YouTube watch URL, or a hosted site's ({@link hostedUrlOf}). Null for an
 * upload, a direct file link (its address is not in its fingerprint) or a
 * fingerprint this module did not write.
 */
export function sourceUrlOf(kind: string, fingerprint: string | null): string | null {
  if (fingerprint === null) return null;
  if (kind === "youtube_url") {
    const match = /^youtube:([\w-]{11})$/.exec(fingerprint);
    return match === null ? null : `https://www.youtube.com/watch?v=${match[1] ?? ""}`;
  }
  return kind === "hosted_url" ? hostedUrlOf(fingerprint) : null;
}

/** Fingerprint prefixes that may carry a share secret, or a caller's whole path. */
const SECRET_BEARING_PREFIXES = ["vimeo:", "gdrive:", "dropbox:", "url:"] as const;

/**
 * A fingerprint as it may be written to the audit log or a log line: a
 * YouTube one (a public video id) and an upload's as they are; a hosted
 * site's or a direct link's as `{site}:#{12 hex}`, the first 12 hex digits
 * of the fingerprint's SHA-256. The same video always gives the same form,
 * so two events about it can still be matched, but a Dropbox `rlkey`, an
 * unlisted Vimeo hash or a Drive file id never leaves the run row.
 */
export function redactedFingerprint(fingerprint: string | null): string | null {
  if (fingerprint === null) return null;
  const prefix = SECRET_BEARING_PREFIXES.find((candidate) => fingerprint.startsWith(candidate));
  if (prefix === undefined) return fingerprint;
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
  return `${prefix}#${digest}`;
}

/** The plain sentence each rejection maps to (§13.4: never a raw parser error). */
export const SOURCE_REJECTION_MESSAGES: Readonly<Record<SourceRejectionCode, string>> =
  Object.freeze({
    not_a_url: "That does not look like a link. Paste the full address of the video.",
    not_https: "Links must start with https:// so the connection is secure.",
    credentials_in_url: "Remove the username and password from the link before pasting it.",
    playlist_not_supported: "Paste a link to one video rather than a playlist or folder.",
    missing_video_id: "That link does not point to a single video.",
    link_too_long:
      "That link is too long to use. Give the file a shorter name, share it again and paste the new link.",
    unsupported_source:
      "We can use a YouTube, Vimeo, Google Drive or Dropbox link. For anything else, upload the video.",
  });

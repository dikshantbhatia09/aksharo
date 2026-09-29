import { SafeFetchError, safeFetch } from "../../common/net/index.js";

import type { AddressResolver, SafeTransport } from "../../common/net/index.js";

/**
 * The one door channel automations have to YouTube (2026-10-02).
 *
 * This machine's IP is also where production downloads videos from, and YouTube
 * already rate-limits it (`SourceGate`), so the rules are narrow on purpose:
 *
 *   * **One host.** A request is a PATH on `https://www.youtube.com`, never a
 *     URL: nothing a person typed can choose the host, the scheme or the port.
 *   * **No redirect off it.** A redirect is followed only to another path on
 *     the same host (`/c/name` moving to `/@handle`, say); anything else -
 *     another host, plain HTTP, a port, credentials - fails the request
 *     without contacting it (`off_host_redirect`). Google's "unusual traffic"
 *     page is such a redirect, which is how a caller tells a block apart.
 *   * **Small and quick.** A byte cap per request (a feed is 1 MiB at most, a
 *     channel page 4 MiB) and a ten-second budget for the whole exchange.
 *   * **No cookies.** None are sent and none are kept: every request is
 *     anonymous, exactly as a logged-out browser's first visit.
 *
 * It rides `safeFetch`, so the address is still vetted and pinned (a hosts-file
 * or DNS answer pointing `www.youtube.com` at this machine is refused).
 * {@link YouTubeHttp} is the seam: tests hand the directory a fake, and no test
 * in this codebase reaches YouTube.
 */

export const YOUTUBE_HOST = "www.youtube.com";
export const YOUTUBE_ORIGIN = `https://${YOUTUBE_HOST}`;

/** A channel's upload feed is tens of kilobytes. */
export const FEED_MAX_BYTES = 1024 * 1024;
/** A channel page is around a megabyte of HTML. */
export const PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The whole exchange, redirects included. */
export const YOUTUBE_TIMEOUT_MS = 10_000;
/** `/c/name` -> `/@handle` is one; three is generous. */
export const YOUTUBE_MAX_REDIRECTS = 3;

/**
 * An honest, ordinary client. A browser's user agent would be a disguise, and a
 * blank one is what scrapers send.
 */
const HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "user-agent": "Mozilla/5.0 (compatible; Aksharo/1.0; channel automations)",
  accept: "text/html,application/xhtml+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.8",
});

export type YouTubeHttpErrorCode =
  "refused_target" | "off_host_redirect" | "too_large" | "timeout" | "network";

export class YouTubeHttpError extends Error {
  constructor(
    readonly code: YouTubeHttpErrorCode,
    message: string,
    /** For `off_host_redirect`: where YouTube tried to send the request. */
    readonly location?: string,
  ) {
    super(message);
    this.name = "YouTubeHttpError";
  }
}

export interface YouTubeResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly contentType: string | null;
}

export interface YouTubeHttp {
  /**
   * GET `path` (with its query) on `https://www.youtube.com`.
   * @throws YouTubeHttpError - never a bare network error.
   */
  get(path: string, maxBytes: number): Promise<YouTubeResponse>;
}

/**
 * The URL for `path` on the one host, or a refusal: a path must start with a
 * single `/`, and resolved against the origin it must still be that origin.
 */
export function youtubeUrl(path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new YouTubeHttpError("refused_target", "not a path on www.youtube.com");
  }
  const url = new URL(path, YOUTUBE_ORIGIN);
  if (url.origin !== YOUTUBE_ORIGIN) {
    throw new YouTubeHttpError("refused_target", "not a path on www.youtube.com");
  }
  return url;
}

/** Whether a redirect keeps the request on `https://www.youtube.com`. */
export function staysOnYouTube(next: URL): boolean {
  return (
    next.protocol === "https:" &&
    next.hostname === YOUTUBE_HOST &&
    next.port === "" &&
    next.username === "" &&
    next.password === ""
  );
}

/** Google's "our systems have detected unusual traffic" page: YouTube refusing this IP. */
export function isBlockPage(location: string | undefined): boolean {
  if (location === undefined) return false;
  try {
    const url = new URL(location);
    return (
      (url.hostname === "google.com" || url.hostname.endsWith(".google.com")) &&
      url.pathname.startsWith("/sorry")
    );
  } catch {
    return false;
  }
}

export class SafeYouTubeHttp implements YouTubeHttp {
  constructor(
    /** Test seams, handed straight to `safeFetch`. */
    private readonly seams: {
      readonly resolver?: AddressResolver;
      readonly transport?: SafeTransport;
    } = {},
  ) {}

  async get(path: string, maxBytes: number): Promise<YouTubeResponse> {
    const url = youtubeUrl(path);
    let refused: URL | undefined;
    try {
      const response = await safeFetch(url.toString(), {
        maxBytes,
        timeoutMs: YOUTUBE_TIMEOUT_MS,
        maxRedirects: YOUTUBE_MAX_REDIRECTS,
        allowedPorts: [443],
        headers: HEADERS,
        allowRedirect: (next) => {
          if (staysOnYouTube(next)) return true;
          refused = next;
          return false;
        },
        ...(this.seams.resolver === undefined ? {} : { resolver: this.seams.resolver }),
        ...(this.seams.transport === undefined ? {} : { transport: this.seams.transport }),
      });
      return {
        status: response.status,
        body: response.body,
        contentType: response.contentType ?? null,
      };
    } catch (error) {
      if (!(error instanceof SafeFetchError)) {
        throw new YouTubeHttpError("network", error instanceof Error ? error.message : "failed");
      }
      switch (error.code) {
        case "redirect_refused":
          throw new YouTubeHttpError(
            "off_host_redirect",
            "YouTube redirected the request off www.youtube.com",
            refused?.toString(),
          );
        case "too_large":
          throw new YouTubeHttpError("too_large", error.message);
        case "timeout":
          throw new YouTubeHttpError("timeout", error.message);
        default:
          throw new YouTubeHttpError("network", error.message);
      }
    }
  }
}

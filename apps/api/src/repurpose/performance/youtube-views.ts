import { PAGE_MAX_BYTES, YouTubeHttpError, isBlockPage } from "../automations/youtube-http.js";

import type { YouTubeGate } from "../automations/youtube-channels.js";
import type { YouTubeHttp, YouTubeResponse } from "../automations/youtube-http.js";

/**
 * A YouTube video's view count, from its public watch page (2026-10-05).
 *
 * The page carries the player's own data as a script
 * (`var ytInitialPlayerResponse = {...};`), and in it `videoDetails.viewCount`
 * - the figure the page shows under the video. Shorts have the same page at
 * `/watch?v=<id>`. Nothing else on the page is used: likes and comments are
 * there in some layouts and not others, so they are not read at all, and a
 * person can type them instead.
 *
 * The object is cut out of the page by matching its braces (strings and
 * escapes respected), then parsed as JSON: nothing on the page is evaluated
 * or followed.
 *
 * **Through the one door, politely.** The request is `SafeYouTubeHttp`'s: one
 * host, no cookies, a byte cap and a deadline, over `safeFetch`. Like channel
 * automations it is made only while `SourceGate` is fully closed - never
 * while it is open or half-open, when one download is meant to find out
 * whether YouTube is answering again - and a refusal (a 429, Google's
 * "unusual traffic" page, the "confirm you're not a bot" wall) trips the gate
 * for every YouTube request this machine makes: this IP is also where videos
 * are downloaded from, and a view count is never worth making that wait longer.
 */

export type WatchPageUnavailable =
  "private" | "removed" | "age_restricted" | "unplayable" | "upcoming" | "consent";

export type WatchPageRead =
  | { readonly kind: "views"; readonly views: number; readonly publishedAt: Date | null }
  | { readonly kind: "unavailable"; readonly reason: WatchPageUnavailable }
  /** YouTube is refusing this IP: the caller has tripped (or must trip) the gate. */
  | { readonly kind: "blocked" }
  /** A page this does not understand: its shape changed, or it is about another video. */
  | { readonly kind: "unreadable"; readonly detail: string };

export type ViewRead =
  | WatchPageRead
  /** The gate is not closed: nothing was asked. */
  | { readonly kind: "busy" }
  /** The request itself failed (network, deadline, size, a status other than 200). */
  | { readonly kind: "failed"; readonly detail: string };

export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** A count held as a Postgres `integer`. */
const MAX_VIEWS = 2_147_483_647;

const PLAYER_RESPONSE =
  /(?:\bvar\s+ytInitialPlayerResponse|window\[\s*["']ytInitialPlayerResponse["']\s*\])\s*=\s*\{/g;
const BOT_CHECK = /not a bot|unusual traffic/i;

/**
 * The JSON object that starts at `html[start]` (a `{`), by matching braces
 * outside strings; null when it never closes.
 */
export function balancedObject(html: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  const holder = record(value);
  if (holder === null) return "";
  if (typeof holder["simpleText"] === "string") return holder["simpleText"];
  const runs = holder["runs"];
  if (Array.isArray(runs)) {
    return runs
      .map((run) => {
        const part = record(run)?.["text"];
        return typeof part === "string" ? part : "";
      })
      .join("");
  }
  return "";
}

function countOf(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return null;
  return Math.min(MAX_VIEWS, Number(value));
}

function playerResponseOf(html: string): Record<string, unknown> | null {
  PLAYER_RESPONSE.lastIndex = 0;
  const match = PLAYER_RESPONSE.exec(html);
  if (match === null) return null;
  const json = balancedObject(html, match.index + match[0].length - 1);
  if (json === null) return null;
  try {
    return record(JSON.parse(json));
  } catch {
    return null;
  }
}

function publishedAtOf(response: Record<string, unknown>): Date | null {
  const renderer = record(record(response["microformat"])?.["playerMicroformatRenderer"]);
  const raw = renderer?.["publishDate"] ?? renderer?.["uploadDate"];
  if (typeof raw !== "string") return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at) : null;
}

/** What a watch page says about `videoId`. */
export function readWatchPage(html: string, videoId: string): WatchPageRead {
  const response = playerResponseOf(html);
  if (response === null) {
    if (BOT_CHECK.test(html)) return { kind: "blocked" };
    if (html.includes("consent.youtube.com")) return { kind: "unavailable", reason: "consent" };
    return { kind: "unreadable", detail: "no player data on the page" };
  }

  const playability = record(response["playabilityStatus"]);
  const status = typeof playability?.["status"] === "string" ? playability["status"] : "";
  const reason = `${text(playability?.["reason"])} ${text(
    Array.isArray(playability?.["messages"]) ? playability["messages"][0] : undefined,
  )}`;
  if (BOT_CHECK.test(reason)) return { kind: "blocked" };

  const details = record(response["videoDetails"]);
  const detailsId = details?.["videoId"];
  if (typeof detailsId === "string" && detailsId !== videoId) {
    return { kind: "unreadable", detail: "the page is about another video" };
  }
  const renderer = record(record(response["microformat"])?.["playerMicroformatRenderer"]);
  const views = countOf(details?.["viewCount"]) ?? countOf(renderer?.["viewCount"]);
  if (views !== null && details !== null) {
    return { kind: "views", views, publishedAt: publishedAtOf(response) };
  }

  if (/private/i.test(reason)) return { kind: "unavailable", reason: "private" };
  if (/\bage\b|inappropriate/i.test(reason)) {
    return { kind: "unavailable", reason: "age_restricted" };
  }
  switch (status) {
    case "ERROR":
      return { kind: "unavailable", reason: "removed" };
    case "UNPLAYABLE":
    case "LOGIN_REQUIRED":
      return { kind: "unavailable", reason: "unplayable" };
    case "LIVE_STREAM_OFFLINE":
      return { kind: "unavailable", reason: "upcoming" };
    default:
      return { kind: "unreadable", detail: "no view count on the page" };
  }
}

/** Reads view counts through the gate. The seam the refresh task is tested through. */
export interface ViewReader {
  read(videoId: string): Promise<ViewRead>;
}

export class YouTubeViewReader implements ViewReader {
  constructor(
    private readonly http: YouTubeHttp,
    /** Null only where there is no Redis at all (a unit harness): then nothing gates. */
    private readonly gate: YouTubeGate | null,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(videoId: string): Promise<ViewRead> {
    if (!YOUTUBE_VIDEO_ID.test(videoId)) return { kind: "unreadable", detail: "not a video id" };
    if (this.gate !== null) {
      const state = await this.gate.state(this.clock());
      if (state.openUntil !== null || state.trips > 0) return { kind: "busy" };
    }

    let response: YouTubeResponse;
    try {
      response = await this.http.get(`/watch?v=${videoId}`, PAGE_MAX_BYTES);
    } catch (error) {
      if (error instanceof YouTubeHttpError && isBlockPage(error.location)) {
        await this.gate?.trip(this.clock());
        return { kind: "blocked" };
      }
      if (error instanceof YouTubeHttpError && isConsentPage(error.location)) {
        return { kind: "unavailable", reason: "consent" };
      }
      return {
        kind: "failed",
        detail: error instanceof YouTubeHttpError ? error.code : "network",
      };
    }

    if (response.status === 429) {
      await this.gate?.trip(this.clock());
      return { kind: "blocked" };
    }
    if (response.status === 404) return { kind: "unavailable", reason: "removed" };
    if (response.status !== 200) {
      return { kind: "failed", detail: `the page answered ${String(response.status)}` };
    }

    const read = readWatchPage(response.body.toString("utf8"), videoId);
    if (read.kind === "blocked") await this.gate?.trip(this.clock());
    return read;
  }
}

/** YouTube's cookie-consent interstitial (served to some regions): not a refusal. */
export function isConsentPage(location: string | undefined): boolean {
  if (location === undefined) return false;
  try {
    return new URL(location).hostname === "consent.youtube.com";
  } catch {
    return false;
  }
}

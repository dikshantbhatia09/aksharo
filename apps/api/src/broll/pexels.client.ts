import { z } from "zod";

import { SafeFetchError, safeFetch } from "../common/net/index.js";

import type { AddressResolver, SafeFetchResult, SafeTransport } from "../common/net/index.js";

/**
 * Stock photos from Pexels (2026-10-05), for the B-roll library: a search, one
 * photo by its id, and a photo's bytes at a bounded size.
 *
 * **Idle until a key is set.** Without `PEXELS_API_KEY` nothing here sends a
 * request, `enabled` is false, the library says stock is off, and the web app
 * shows no stock search at all.
 *
 * **One door each way.** Every request rides `safeFetch`, so the address is
 * vetted and pinned: the API only as a path on `https://api.pexels.com` that
 * this client builds (never a URL a person typed), a photo's bytes only from
 * `https://images.pexels.com`, and no redirect off either host.
 *
 * **Its allowance.** Pexels allows a key 200 requests an hour and 20,000 a
 * month. {@link PexelsBudget} counts this process's calls to the API over the
 * last hour and stops at `PEXELS_REQUESTS_PER_HOUR` (default 150, under Pexels's
 * own count), keeping a third of them for people: Autopilot's searches stop at
 * two thirds. A 429, or an answer saying none are left, pauses every call until
 * Pexels's `X-Ratelimit-Reset`, else for a quarter of an hour. Downloading a
 * photo's bytes does not count against it.
 *
 * **Its licence.** A Pexels photo may be used in a video without credit, but
 * not sold or offered as a stock library of our own: a saved photo is kept in
 * one workspace's private library, with its photographer's credit beside it.
 */

export const PEXELS_API_KEY_ENV = "PEXELS_API_KEY";
export const PEXELS_REQUESTS_PER_HOUR_ENV = "PEXELS_REQUESTS_PER_HOUR";

export const PEXELS_API_HOST = "api.pexels.com";
export const PEXELS_IMAGE_HOST = "images.pexels.com";

/** Under Pexels's own 200 an hour, with room for a clock that disagrees with theirs. */
export const DEFAULT_PEXELS_REQUESTS_PER_HOUR = 150;

/** Autopilot's share of the hourly allowance; the rest is kept for people searching. */
export const AUTOPILOT_SHARE = 2 / 3;

/** A search answer is a few tens of kilobytes. */
const API_MAX_BYTES = 2 * 1024 * 1024;
const API_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** How long every call waits after a 429 that says nothing about when to come back. */
const DEFAULT_PAUSE_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;

/** Who is asking: a person at the page, or Autopilot filling a clip. */
export type PexelsPurpose = "person" | "autopilot";

/** How a picture is shaped, as Pexels filters a search by it. */
export type PexelsOrientation = "portrait" | "landscape" | "square";

export type PexelsErrorCode = "disabled" | "busy" | "not_found" | "unavailable";

export class PexelsError extends Error {
  constructor(
    readonly code: PexelsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PexelsError";
  }
}

/** One photo, in the shape Pexels documents (`GET /v1/search`, `GET /v1/photos/:id`). */
const PhotoSchema = z.object({
  id: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string(),
  photographer: z.string(),
  photographer_url: z.string(),
  alt: z.string().nullable().optional(),
  src: z.object({
    original: z.string(),
    large2x: z.string(),
    large: z.string(),
    medium: z.string(),
    portrait: z.string(),
    landscape: z.string(),
  }),
});

const SearchSchema = z.object({
  page: z.number().int().optional(),
  per_page: z.number().int().optional(),
  total_results: z.number().int().optional(),
  photos: z.array(PhotoSchema),
});

/** A photo as the library uses it. */
export interface PexelsPhoto {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** The photo's page on Pexels. */
  readonly pageUrl: string;
  readonly photographer: string;
  readonly photographerUrl: string;
  /** Pexels's description of it; empty when it has none. */
  readonly alt: string;
  /** The full-size file on images.pexels.com: what a saved copy is sized from. */
  readonly originalUrl: string;
  /** About 350 px high, for a results grid. */
  readonly previewUrl: string;
}

function photoOf(raw: z.infer<typeof PhotoSchema>): PexelsPhoto {
  return {
    id: raw.id,
    width: raw.width,
    height: raw.height,
    pageUrl: raw.url,
    photographer: raw.photographer,
    photographerUrl: raw.photographer_url,
    alt: (raw.alt ?? "").trim(),
    originalUrl: raw.src.original,
    previewUrl: raw.src.medium,
  };
}

/** `PEXELS_API_KEY` and the hourly allowance, read without ever throwing or logging the key. */
export interface PexelsSetting {
  readonly apiKey: string | null;
  readonly requestsPerHour: number;
}

export function pexelsSetting(source: NodeJS.ProcessEnv = process.env): PexelsSetting {
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const apiKey = (source[PEXELS_API_KEY_ENV] ?? "").trim();
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const raw = Number.parseInt((source[PEXELS_REQUESTS_PER_HOUR_ENV] ?? "").trim(), 10);
  return {
    apiKey: apiKey === "" ? null : apiKey,
    requestsPerHour:
      Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : DEFAULT_PEXELS_REQUESTS_PER_HOUR,
  };
}

/**
 * This process's calls to the Pexels API over the last hour, and a pause when
 * Pexels asks for one. One API process serves this deployment, so a count in
 * memory is the deployment's count.
 */
export class PexelsBudget {
  #calls: number[] = [];
  #pausedUntil = 0;

  constructor(
    readonly perHour: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Takes one call for `purpose`; false when its share of the hour is spent or a pause is on. */
  take(purpose: PexelsPurpose): boolean {
    const now = this.clock();
    if (now < this.#pausedUntil) return false;
    this.#calls = this.#calls.filter((at) => now - at < HOUR_MS);
    const cap = purpose === "autopilot" ? Math.floor(this.perHour * AUTOPILOT_SHARE) : this.perHour;
    if (this.#calls.length >= cap) return false;
    this.#calls.push(now);
    return true;
  }

  /** Every call waits until `until` (epoch ms); an earlier pause never shortens a later one. */
  pauseUntil(until: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, until);
  }

  get pausedUntil(): number {
    return this.#pausedUntil;
  }
}

/** Whether `url` is a path on `https://{host}` with nothing else unusual about it. */
function onHost(url: URL, host: string): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === host &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/** The seams a test replaces: `safeFetch`'s resolver and transport, and the clock. */
export interface PexelsSeams {
  readonly resolver?: AddressResolver;
  readonly transport?: SafeTransport;
  readonly clock?: () => number;
}

export class PexelsClient {
  readonly budget: PexelsBudget;
  private readonly apiKey: string | null;
  private readonly clock: () => number;

  constructor(
    setting: PexelsSetting,
    private readonly seams: PexelsSeams = {},
  ) {
    this.apiKey = setting.apiKey;
    this.clock = seams.clock ?? Date.now;
    this.budget = new PexelsBudget(setting.requestsPerHour, this.clock);
  }

  /** Whether a key is set: without one, stock photos are off everywhere. */
  get enabled(): boolean {
    return this.apiKey !== null;
  }

  /**
   * One page of photos matching `query`, shaped like `orientation`.
   * @throws PexelsError
   */
  async search(
    query: string,
    options: {
      readonly orientation?: PexelsOrientation;
      readonly perPage: number;
      readonly page?: number;
    },
    purpose: PexelsPurpose,
  ): Promise<PexelsPhoto[]> {
    const params = new URLSearchParams({
      query,
      per_page: String(options.perPage),
      page: String(options.page ?? 1),
    });
    if (options.orientation !== undefined) params.set("orientation", options.orientation);
    const body = await this.api(`/v1/search?${params.toString()}`, purpose);
    const parsed = SearchSchema.safeParse(body);
    if (!parsed.success) {
      throw new PexelsError(
        "unavailable",
        "Pexels answered a search in a shape it does not document",
      );
    }
    return parsed.data.photos.map(photoOf);
  }

  /**
   * One photo by its Pexels id: what a save reads, so the bytes are fetched
   * from the address Pexels gives, never one a person sent.
   * @throws PexelsError `not_found` for a photo Pexels does not have.
   */
  async photo(id: number, purpose: PexelsPurpose): Promise<PexelsPhoto> {
    const body = await this.api(`/v1/photos/${String(id)}`, purpose);
    const parsed = PhotoSchema.safeParse(body);
    if (!parsed.success) {
      throw new PexelsError(
        "unavailable",
        "Pexels answered a photo in a shape it does not document",
      );
    }
    return photoOf(parsed.data);
  }

  /**
   * A photo's bytes with its long side at most `longSide`: asked of Pexels's
   * own image service at exactly the photo's shape, so whichever way it fits a
   * size the picture is never cropped. The caller checks what came back.
   * @throws PexelsError
   */
  async download(photo: PexelsPhoto, longSide: number, maxBytes: number): Promise<Uint8Array> {
    if (!this.enabled) throw new PexelsError("disabled", "stock photos are not set up");
    let url: URL;
    try {
      url = new URL(photo.originalUrl);
    } catch {
      throw new PexelsError("unavailable", "the photo's address is not a URL");
    }
    if (!onHost(url, PEXELS_IMAGE_HOST)) {
      throw new PexelsError("unavailable", "the photo is not on images.pexels.com");
    }
    const long = Math.min(longSide, Math.max(photo.width, photo.height));
    const landscape = photo.width >= photo.height;
    const width = landscape ? long : Math.max(1, Math.round((photo.width * long) / photo.height));
    const height = landscape ? Math.max(1, Math.round((photo.height * long) / photo.width)) : long;
    url.search = new URLSearchParams({
      auto: "compress",
      cs: "tinysrgb",
      w: String(width),
      h: String(height),
      dpr: "1",
    }).toString();
    const response = await this.fetch(url.toString(), PEXELS_IMAGE_HOST, {
      maxBytes,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      headers: { accept: "image/*" },
    });
    if (response.status !== 200) {
      throw new PexelsError(
        response.status === 404 ? "not_found" : "unavailable",
        `images.pexels.com answered ${String(response.status)}`,
      );
    }
    return new Uint8Array(response.body);
  }

  /** GET `path` on the API, counted against the allowance; the parsed JSON body. */
  private async api(path: string, purpose: PexelsPurpose): Promise<unknown> {
    const key = this.apiKey;
    if (key === null) throw new PexelsError("disabled", "stock photos are not set up");
    if (!this.budget.take(purpose)) {
      throw new PexelsError("busy", "the hour's stock photo searches are spent");
    }
    const response = await this.fetch(`https://${PEXELS_API_HOST}${path}`, PEXELS_API_HOST, {
      maxBytes: API_MAX_BYTES,
      timeoutMs: API_TIMEOUT_MS,
      headers: { authorization: key, accept: "application/json" },
    });
    this.notePause(response);
    if (response.status === 429) {
      throw new PexelsError("busy", "Pexels asked for a pause");
    }
    if (response.status === 404) throw new PexelsError("not_found", "Pexels has no such photo");
    if (response.status !== 200) {
      throw new PexelsError("unavailable", `Pexels answered ${String(response.status)}`);
    }
    try {
      return JSON.parse(response.body.toString("utf8")) as unknown;
    } catch {
      throw new PexelsError("unavailable", "Pexels answered with something that is not JSON");
    }
  }

  /**
   * Pexels's headers count the month (`X-Ratelimit-Remaining`, and
   * `X-Ratelimit-Reset`, epoch seconds, when the month rolls over). None left
   * this month pauses every call until that reset; a 429 with some left is the
   * hourly limit, and pauses every call for a quarter of an hour.
   */
  private notePause(response: SafeFetchResult): void {
    const now = this.clock();
    const remainingHeader = response.headers["x-ratelimit-remaining"];
    const remaining = remainingHeader === undefined ? Number.NaN : Number(remainingHeader);
    if (Number.isFinite(remaining) && remaining <= 0) {
      const reset = Number(response.headers["x-ratelimit-reset"]) * 1_000;
      // A reset in the past, or further off than a month, is not trusted.
      const trusted = Number.isFinite(reset) && reset > now && reset - now <= 32 * 24 * HOUR_MS;
      this.budget.pauseUntil(trusted ? reset : now + DEFAULT_PAUSE_MS);
      return;
    }
    if (response.status === 429) this.budget.pauseUntil(now + DEFAULT_PAUSE_MS);
  }

  private async fetch(
    url: string,
    host: string,
    options: {
      readonly maxBytes: number;
      readonly timeoutMs: number;
      readonly headers: Readonly<Record<string, string>>;
    },
  ): Promise<SafeFetchResult> {
    try {
      return await safeFetch(url, {
        maxBytes: options.maxBytes,
        timeoutMs: options.timeoutMs,
        maxRedirects: 2,
        allowedPorts: [443],
        headers: {
          "user-agent": "Aksharo/1.0 (+b-roll library)",
          ...options.headers,
        },
        allowRedirect: (next) => onHost(next, host),
        ...(this.seams.resolver === undefined ? {} : { resolver: this.seams.resolver }),
        ...(this.seams.transport === undefined ? {} : { transport: this.seams.transport }),
      });
    } catch (error) {
      if (error instanceof SafeFetchError) {
        throw new PexelsError("unavailable", `could not reach ${host}: ${error.code}`);
      }
      throw new PexelsError("unavailable", `could not reach ${host}`);
    }
  }
}

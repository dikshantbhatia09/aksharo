import { Inject, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { postizSetting, type PostizSetting } from "./postiz-env.js";
import { PostizError, type PostizErrorKind } from "./postiz.errors.js";
import {
  PostizCreatedSchema,
  PostizIntegrationListSchema,
  PostizMediaSchema,
  PostizPostListSchema,
  type PostizCreatePostInput,
  type PostizIntegration,
  type PostizMedia,
  type PostizPost,
} from "./postiz.schemas.js";

import type { ZodType } from "zod";

/**
 * A small server-to-server client for Postiz's Public API (master plan §12.2),
 * rather than Postiz's SDK: the SDK's `upload()` labels an unknown extension
 * `image/jpeg`, which is exactly the MP4 case, and a narrow client keeps the
 * API from coupling to Postiz's DTOs.
 *
 * Endpoints (https://docs.postiz.com/public-api, checked against the Postiz
 * v1.47 source): `GET /public/v1/integrations`, `POST /public/v1/upload`
 * (multipart, field `file`), `POST /public/v1/posts`, `GET /public/v1/posts`
 * (a date window) and `DELETE /public/v1/posts/{id}`; and, for learning what
 * works (2026-10-05, `repurpose/performance`), `GET /public/v1/analytics/post/
 * {id}`. The key goes in the `Authorization` header as it is, no `Bearer`.
 *
 * What it holds to:
 *
 *   * **Strict deadlines** on every call, and a body-size cap on every answer.
 *   * **Only reads retry by themselves** (once). A post or an upload is never
 *     re-sent here; the caller decides, from {@link PostizError.uncertain}.
 *   * **A breaker**: after {@link BREAKER_FAILURES} failures in a row that say
 *     Postiz is down, calls fail at once for {@link BREAKER_OPEN_MS} instead
 *     of queueing up behind a dead service. Such a refusal is "unreachable":
 *     nothing was sent, so a post refused this way is safe to try later.
 *   * **Nothing logged here**, and the key is never part of an error.
 */

const PUBLIC_API = "/public/v1";

/** Reads: the integration list, a window of posts, a delete. */
const READ_TIMEOUT_MS = 15_000;
/** Creating a post: Postiz validates it against the provider before answering. */
const WRITE_TIMEOUT_MS = 30_000;
/** An upload's deadline grows with the file: a minute, plus two seconds a MB, at most 20 min. */
const UPLOAD_BASE_TIMEOUT_MS = 60_000;
const UPLOAD_PER_MB_MS = 2_000;
const UPLOAD_MAX_TIMEOUT_MS = 20 * 60_000;

const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_SMALL_BYTES = 1024 * 1024;

/** A 429 without `Retry-After`: Postiz's window is an hour, so wait a quarter of it. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 15 * 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 60_000;

/** Errors that mean the connection never opened, so nothing was sent. */
const CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface PostizClientOptions {
  readonly setting: PostizSetting;
  readonly fetch: typeof fetch;
  /** Injected in tests; `Date.now` otherwise. */
  readonly now?: () => number;
  /** Injected in tests so the one read retry does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** DI token for {@link PostizClientOptions}; tests construct the client directly. */
export const POSTIZ_CLIENT_OPTIONS = Symbol("POSTIZ_CLIENT_OPTIONS");

/** The production options: the environment and the platform `fetch`. */
export function postizClientOptions(): PostizClientOptions {
  return { setting: postizSetting(), fetch: globalThis.fetch.bind(globalThis) };
}

interface SendInit {
  readonly query?: URLSearchParams;
  readonly json?: unknown;
  readonly stream?: { readonly body: ReadableStream<Uint8Array>; readonly contentType: string };
  readonly timeoutMs: number;
}

@Injectable()
export class PostizClient {
  private failures = 0;
  private openUntil = 0;

  constructor(@Inject(POSTIZ_CLIENT_OPTIONS) private readonly options: PostizClientOptions) {}

  /** A key is set and the URL is one the key may be sent to. */
  get configured(): boolean {
    return this.options.setting.kind === "ok";
  }

  get setting(): PostizSetting {
    return this.options.setting;
  }

  /** Where a person opens Postiz to connect accounts, when it is set up. */
  get appUrl(): string | null {
    return this.options.setting.kind === "ok" ? this.options.setting.appUrl : null;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Every channel connected in this Postiz organisation. */
  async listIntegrations(): Promise<PostizIntegration[]> {
    const body = await this.readWithRetry("/integrations", undefined, MAX_SMALL_BYTES);
    return this.parse(PostizIntegrationListSchema, body);
  }

  /** Posts whose publish date falls inside the window (deleted ones never appear). */
  async listPosts(start: Date, end: Date): Promise<PostizPost[]> {
    const query = new URLSearchParams({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    const body = await this.readWithRetry("/posts", query, MAX_LIST_BYTES);
    return this.parse(PostizPostListSchema, body).posts;
  }

  /**
   * One post's figures over the last `days` (2026-10-05): the platform's own
   * labels and series, as Postiz answers them, for `repurpose/performance/
   * postiz-analytics.ts` to read - it knows their odd shapes, so this only
   * checks the answer is JSON.
   *
   * ONE request, never retried here, unlike the other reads: the key's hourly
   * allowance is shared with posting, and the caller already schedules the
   * next read of every post.
   */
  async postAnalytics(postId: string, days: number): Promise<unknown> {
    const response = await this.send("GET", `/analytics/post/${encodeURIComponent(postId)}`, {
      query: new URLSearchParams({ date: String(days) }),
      timeoutMs: READ_TIMEOUT_MS,
    });
    const text = await this.readBody(response, MAX_SMALL_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PostizError("malformed", "Postiz answered with something that is not JSON.");
    }
  }

  // -------------------------------------------------------------------------
  // Writes: never retried here
  // -------------------------------------------------------------------------

  /**
   * Upload one MP4 as `multipart/form-data`, streaming `body` straight through
   * (the API never holds the whole file). The part is labelled `video/mp4`;
   * Postiz sniffs the bytes itself anyway and refuses anything else.
   */
  async uploadVideo(input: {
    readonly body: ReadableStream<Uint8Array>;
    readonly filename: string;
    readonly sizeBytes: number | null;
  }): Promise<PostizMedia> {
    const boundary = `----AksharoBoundary${ulid()}`;
    const response = await this.send("POST", "/upload", {
      stream: {
        body: multipartVideo(input.body, boundary, input.filename),
        contentType: `multipart/form-data; boundary=${boundary}`,
      },
      timeoutMs: uploadTimeoutMs(input.sizeBytes),
    });
    return this.parse(PostizMediaSchema, await this.readBody(response, MAX_SMALL_BYTES));
  }

  /** Create one post on one channel, now or at `date`. Answers Postiz's post id. */
  async createPost(input: PostizCreatePostInput): Promise<{ readonly postId: string }> {
    const response = await this.send("POST", "/posts", {
      json: {
        type: input.type,
        // Required even for `now` (Postiz validates it and then ignores it).
        date: input.date.toISOString(),
        // Postiz's link shortener needs its own account; leave links as written.
        shortLink: false,
        tags: [],
        posts: [
          {
            integration: { id: input.integrationId },
            value: [
              {
                content: input.contentHtml,
                image: [{ id: input.media.id, path: input.media.path }],
              },
            ],
            settings: { ...input.settings, __type: input.identifier },
          },
        ],
      },
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    const created = this.parse(PostizCreatedSchema, await this.readBody(response, MAX_SMALL_BYTES));
    const first = created[0];
    if (first === undefined) {
      throw new PostizError("malformed", "Postiz answered without a post id.");
    }
    return { postId: first.postId };
  }

  /**
   * Delete a post (and its group). `missing` when Postiz no longer has it,
   * which is the state the caller asked for.
   */
  async deletePost(postId: string): Promise<"deleted" | "missing"> {
    try {
      await this.send("DELETE", `/posts/${encodeURIComponent(postId)}`, {
        timeoutMs: READ_TIMEOUT_MS,
      });
      return "deleted";
    } catch (error) {
      if (error instanceof PostizError && error.kind === "not_found") return "missing";
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** A GET, retried once after a short pause when the failure says "try again". */
  private async readWithRetry(
    path: string,
    query: URLSearchParams | undefined,
    maxBytes: number,
  ): Promise<string> {
    try {
      return await this.readBody(
        await this.send("GET", path, {
          ...(query === undefined ? {} : { query }),
          timeoutMs: READ_TIMEOUT_MS,
        }),
        maxBytes,
      );
    } catch (error) {
      const retry =
        error instanceof PostizError &&
        (error.kind === "server" || error.kind === "network" || error.kind === "timeout");
      if (!retry || this.now() < this.openUntil) throw error;
      await (this.options.sleep ?? defaultSleep)(500);
      return this.readBody(
        await this.send("GET", path, {
          ...(query === undefined ? {} : { query }),
          timeoutMs: READ_TIMEOUT_MS,
        }),
        maxBytes,
      );
    }
  }

  private async send(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: SendInit,
  ): Promise<Response> {
    const setting = this.options.setting;
    if (setting.kind !== "ok") {
      throw new PostizError("not_configured", "Postiz is not set up (POSTIZ_API_KEY).");
    }
    if (this.now() < this.openUntil) {
      throw new PostizError("unreachable", "Postiz is not answering; waiting before asking again.");
    }

    const url = `${setting.apiUrl}${PUBLIC_API}${path}${init.query === undefined ? "" : `?${init.query.toString()}`}`;
    const headers: Record<string, string> = {
      // Postiz reads the key as-is: no `Bearer` prefix (docs: public-api/introduction).
      Authorization: setting.apiKey,
      Accept: "application/json",
      // For following one call through Postiz's own logs; carries nothing else.
      "X-Request-Id": ulid(),
    };
    let body: RequestInit["body"] | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.stream !== undefined) {
      headers["Content-Type"] = init.stream.contentType;
      body = init.stream.body;
    }

    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        // Node's fetch needs this to send a stream body; harmless otherwise.
        ...(init.stream === undefined ? {} : { duplex: "half" }),
        signal: AbortSignal.timeout(init.timeoutMs),
        redirect: "error",
      } as RequestInit);
    } catch (error) {
      const kind = fetchFailureKind(error);
      this.recordFailure(kind);
      throw new PostizError(kind, describeFetchFailure(kind));
    }

    if (response.ok) {
      this.failures = 0;
      return response;
    }
    throw await this.statusError(response);
  }

  private async statusError(response: Response): Promise<PostizError> {
    let detail: string | null = null;
    try {
      detail = detailOf(await readCapped(response, 64 * 1024));
    } catch {
      detail = null;
    }
    const status = response.status;
    const kind: PostizErrorKind =
      status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not_found"
            : status === 413
              ? "too_large"
              : status === 429
                ? "rate_limited"
                : status >= 500
                  ? "server"
                  : "bad_request";
    if (kind === "server") this.recordFailure(kind);
    else this.failures = 0;
    return new PostizError(kind, `Postiz answered ${String(status)}.`, {
      status,
      detail,
      retryAfterMs:
        kind === "rate_limited"
          ? (retryAfterMsOf(response.headers.get("retry-after"), this.now()) ??
            DEFAULT_RATE_LIMIT_WAIT_MS)
          : null,
    });
  }

  private recordFailure(kind: PostizErrorKind): void {
    if (kind !== "unreachable" && kind !== "server" && kind !== "timeout" && kind !== "network") {
      return;
    }
    this.failures += 1;
    if (this.failures >= BREAKER_FAILURES) {
      this.openUntil = this.now() + BREAKER_OPEN_MS;
      this.failures = 0;
    }
  }

  private async readBody(response: Response, maxBytes: number): Promise<string> {
    try {
      return await readCapped(response, maxBytes);
    } catch (error) {
      if (error instanceof PostizError) throw error;
      // The status was a success, so the work may be done: this is not "down".
      throw new PostizError("network", "The answer from Postiz was cut off.");
    }
  }

  private parse<T>(schema: ZodType<T>, text: string): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PostizError("malformed", "Postiz answered with something that is not JSON.");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new PostizError("malformed", "Postiz answered in a shape this version does not know.", {
        detail: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
          .join("; "),
      });
    }
    return parsed.data;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long an upload of `sizeBytes` may take before it is abandoned. */
export function uploadTimeoutMs(sizeBytes: number | null): number {
  const megabytes = sizeBytes === null ? 100 : sizeBytes / (1024 * 1024);
  return Math.min(
    UPLOAD_MAX_TIMEOUT_MS,
    Math.round(UPLOAD_BASE_TIMEOUT_MS + megabytes * UPLOAD_PER_MB_MS),
  );
}

function fetchFailureKind(error: unknown): PostizErrorKind {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    const cause = (error as { cause?: unknown }).cause;
    const code =
      typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
    if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return "unreachable";
    if (name === "TypeError" && cause === undefined) return "unreachable";
  }
  return "network";
}

function describeFetchFailure(kind: PostizErrorKind): string {
  switch (kind) {
    case "timeout":
      return "Postiz did not answer in time.";
    case "unreachable":
      return "Postiz could not be reached.";
    default:
      return "The connection to Postiz broke.";
  }
}

/** `Retry-After` as milliseconds: seconds, or an HTTP date. */
export function retryAfterMsOf(raw: string | null, now: number): number | null {
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(at - now, MAX_RETRY_AFTER_MS));
}

/** Postiz's own message from an error body (`msg`, or Nest's `message`), short. */
function detailOf(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const body = JSON.parse(trimmed) as { msg?: unknown; message?: unknown };
    const message = body.msg ?? body.message;
    if (typeof message === "string") return message.slice(0, 300);
    if (Array.isArray(message)) {
      return message
        .filter((entry): entry is string => typeof entry === "string")
        .join("; ")
        .slice(0, 300);
    }
  } catch {
    // Not JSON: a proxy's error page, say. Keep the start of it for the log.
  }
  return trimmed.slice(0, 300);
}

/** The body as text, refusing past `maxBytes` rather than buffering it all. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PostizError("malformed", "The answer from Postiz was larger than expected.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PostizError("malformed", "The answer from Postiz was larger than expected.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `multipart/form-data` with one part, `file`, around a stream: the preamble,
 * the bytes as they arrive, the closing boundary. Pull-based, so the file is
 * read only as fast as Postiz takes it.
 */
export function multipartVideo(
  file: ReadableStream<Uint8Array>,
  boundary: string,
  filename: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Quotes and line breaks would end the header early; the name is cosmetic.
  const safeName = filename.replace(/["\r\n\\]/g, "").slice(0, 120) || "clip.mp4";
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      "Content-Type: video/mp4\r\n\r\n",
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = file.getReader();
  let stage: "head" | "body" | "done" = "head";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === "head") {
        stage = "body";
        controller.enqueue(head);
        return;
      }
      if (stage === "body") {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        stage = "done";
        controller.enqueue(tail);
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

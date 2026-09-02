/**
 * The typed fetch layer.
 *
 * One `ApiClient` per surface (the browser has exactly one). It owns four things
 * a caller should never repeat: the base URL, the bearer header, the error
 * envelope, and the single-flight refresh that CONTRACTS §5 makes possible with
 * its 60 s rotation grace.
 *
 * It deliberately does **not** own token storage: the browser keeps the refresh
 * token in an httpOnly cookie that only a route handler can read, the desktop app
 * keeps it in the OS keychain, and a panel holds nothing at all. The client asks
 * for an access token through `getAccessToken` and asks for a new one through
 * `refreshAccessToken`.
 */

import { ApiError, CLIENT_ERROR_CODES, parseErrorEnvelope } from "./errors.js";

import type { ApiOperationId } from "./generated/operations.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * One route.
 *
 * `operationId` is present when the route exists in the generated index, so the
 * contract test can compare method and path against the OpenAPI document.
 * `pending` marks a route `07-api-and-contracts.md` specifies but whose work
 * package has not landed; calling one raises `client/not_implemented` rather
 * than a confusing 404.
 */
export interface EndpointSpec<TRequest = void, TResponse = unknown> {
  readonly method: HttpMethod;
  /** Path template with `{name}` placeholders, e.g. `/auth/sessions/{sessionId}`. */
  readonly path: string;
  readonly auth: "public" | "bearer";
  readonly operationId?: ApiOperationId;
  /** The owning work package, for the message a pending endpoint raises. */
  readonly pending?: string;
  /** Phantom fields: they carry the types, and never exist at runtime. */
  readonly __request?: TRequest;
  readonly __response?: TResponse;
}

export function defineEndpoint<TRequest = void, TResponse = unknown>(
  spec: Omit<EndpointSpec<TRequest, TResponse>, "__request" | "__response">,
): EndpointSpec<TRequest, TResponse> {
  return spec;
}

export type RequestOf<E> = E extends EndpointSpec<infer R, unknown> ? R : never;
export type ResponseOf<E> = E extends EndpointSpec<never, infer R> ? R : never;

export interface CallOptions<TRequest> {
  /** Values for the `{placeholders}` in the path. */
  params?: Record<string, string>;
  /** Appended as the query string; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: TRequest;
  signal?: AbortSignal;
  /** Extra headers. `Idempotency-Key` on job- and payment-creating POSTs. */
  headers?: Record<string, string>;
  /** Skip the refresh-and-retry dance (used by the refresh call itself). */
  noRetryOn401?: boolean;
}

export interface ApiClientOptions {
  /** Origin of the API, without a trailing slash. */
  baseUrl: string;
  /** The current access token, or `null` when signed out. */
  getAccessToken?: () => string | null;
  /**
   * Obtain a fresh access token. Called at most once per 401, and shared by
   * every request that hit a 401 at the same time.
   */
  refreshAccessToken?: () => Promise<string | null>;
  /** Called when a refresh fails: the family is revoked, or there was none. */
  onUnauthenticated?: () => void;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const JSON_TYPE = "application/json";

export class ApiClient {
  private readonly options: ApiClientOptions;
  private readonly doFetch: typeof fetch;
  /** The in-flight refresh, so ten parallel 401s cause one rotation. */
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(options: ApiClientOptions) {
    this.options = options;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  /** The WebSocket origin for the realtime gateway: `http` → `ws`. */
  get realtimeUrl(): string {
    return `${this.baseUrl.replace(/^http/, "ws")}/realtime`;
  }

  async call<TRequest, TResponse>(
    endpoint: EndpointSpec<TRequest, TResponse>,
    options: CallOptions<TRequest> = {},
  ): Promise<TResponse> {
    if (endpoint.pending !== undefined) {
      throw new ApiError({
        code: CLIENT_ERROR_CODES.notImplemented,
        message: `${endpoint.method} ${endpoint.path} lands with ${endpoint.pending}.`,
        status: 501,
        details: { endpoint: endpoint.path, owner: endpoint.pending },
      });
    }
    return this.send(endpoint, options, false);
  }

  private async send<TRequest, TResponse>(
    endpoint: EndpointSpec<TRequest, TResponse>,
    options: CallOptions<TRequest>,
    isRetry: boolean,
  ): Promise<TResponse> {
    const url = this.buildUrl(endpoint.path, options.params, options.query);
    const headers: Record<string, string> = { Accept: JSON_TYPE, ...options.headers };

    if (endpoint.auth === "bearer") {
      const token = this.options.getAccessToken?.() ?? null;
      if (token !== null) headers["Authorization"] = `Bearer ${token}`;
    }

    const hasBody = options.body !== undefined && endpoint.method !== "GET";
    if (hasBody) headers["Content-Type"] = JSON_TYPE;

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: endpoint.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        // The API is a different origin and authenticates with a bearer token,
        // so no cookie should ever ride along.
        credentials: "omit",
        mode: "cors",
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw new ApiError({
          code: CLIENT_ERROR_CODES.aborted,
          message: "The request was cancelled.",
          status: 0,
          cause,
        });
      }
      throw new ApiError({
        code: CLIENT_ERROR_CODES.networkUnreachable,
        message: "We could not reach the server. Check your connection and try again.",
        status: 0,
        cause,
      });
    }

    // Only a request that carried a bearer token can have an *expired* one. A
    // 401 from a public route is a domain answer — `auth/invalid_credentials`
    // from a wrong password — and rotating on it would sign the user out of a
    // session they were in the middle of creating.
    const canRefresh =
      response.status === 401 &&
      endpoint.auth === "bearer" &&
      !isRetry &&
      options.noRetryOn401 !== true;

    if (canRefresh) {
      const token = await this.refreshOnce();
      if (token !== null) return this.send(endpoint, options, true);
      this.options.onUnauthenticated?.();
    }

    if (!response.ok) throw await toApiError(response);
    return (await readJson(response)) as TResponse;
  }

  /** Collapse concurrent refreshes into one rotation (CONTRACTS §5). */
  private async refreshOnce(): Promise<string | null> {
    if (this.options.refreshAccessToken === undefined) return null;
    this.refreshInFlight ??= this.options
      .refreshAccessToken()
      .catch(() => null)
      .finally(() => {
        this.refreshInFlight = null;
      });
    return this.refreshInFlight;
  }

  private buildUrl(
    path: string,
    params: Record<string, string> | undefined,
    query: CallOptions<unknown>["query"],
  ): string {
    const filled = path.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params?.[name];
      if (value === undefined) throw new Error(`missing path parameter "${name}" for ${path}`);
      return encodeURIComponent(value);
    });

    const url = new URL(`${this.baseUrl}${filled}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ApiError({
      code: CLIENT_ERROR_CODES.malformedResponse,
      message: "The server sent a response we could not read.",
      status: response.status,
      cause,
    });
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs =
    retryAfter === null || Number.isNaN(Number(retryAfter)) ? undefined : Number(retryAfter) * 1000;

  let envelope: ReturnType<typeof parseErrorEnvelope>;
  try {
    envelope = parseErrorEnvelope(await response.clone().json());
  } catch {
    envelope = undefined;
  }

  if (envelope === undefined) {
    return new ApiError({
      code: CLIENT_ERROR_CODES.malformedResponse,
      message: `The server answered ${String(response.status)}.`,
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  return new ApiError({
    code: envelope.code,
    message: envelope.message,
    status: response.status,
    details: envelope.details,
    ...(envelope.requestId === undefined ? {} : { requestId: envelope.requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

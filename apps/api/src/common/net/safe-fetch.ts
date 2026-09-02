import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { reasonAddressIsDenied } from "./ip-rules.js";

import type { LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";

/**
 * The egress-restricted HTTP client (THREAT-MODEL **T6**, server-side request
 * forgery).
 *
 * Every user-supplied URL the platform fetches goes through here: subtitle
 * import-from-URL (A06), and the public API and webhook deliveries later (B14).
 * The rules, in the order they are applied to each hop:
 *
 * 1. **Scheme and port.** `http` and `https` only, on a permitted port. `file:`,
 *    `gopher:`, `redis:` and friends never get as far as a resolver.
 * 2. **Resolve first, judge the addresses.** Every address the name resolves to
 *    is checked against `ip-rules.ts`; if any one of them is private, loopback,
 *    link-local, the metadata service, a ULA or otherwise reserved, the whole
 *    request is refused. Judging *all* of them, not just the one we would use,
 *    is what stops a name with one public and one private record.
 * 3. **Pin the address.** The connection is made to the vetted IP with the
 *    original `Host` header (and SNI), so the name cannot be re-resolved to a
 *    different address between the check and the connect — that gap is the whole
 *    of DNS rebinding.
 * 4. **Cap redirects, size and time.** A redirect is a fresh URL and gets the
 *    full treatment again, which is how "public host redirects to
 *    169.254.169.254" is caught. The body is counted as it arrives and the
 *    socket is destroyed the moment it goes over, so a hostile server cannot
 *    stream forever.
 *
 * Nothing here is a Nest provider: it is a function, so a caller does not need a
 * module and a test does not need a container. The seams that a test needs -
 * the resolver and the transport - are optional parameters.
 */

export type SafeFetchErrorCode =
  | "blocked_scheme"
  | "blocked_port"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "request_failed";

/** A refusal, with a machine-readable reason the caller maps onto an error code. */
export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/** Ports an outbound request may use. Anything else is somebody probing. */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

/** At most this many redirects are followed (brief §8). */
export const DEFAULT_MAX_REDIRECTS = 3;

/** Default body cap: the same 2 MB an inline subtitle import is allowed. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Default budget for the whole exchange, redirects included. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Resolve a hostname to its addresses. Injected in tests; `dns.lookup` in production. */
export type AddressResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

export interface SafeTransportRequest {
  readonly url: URL;
  /** The vetted address the socket must connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface SafeTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Release the socket early, when the caller stops reading. */
  destroy(): void;
}

export type SafeTransport = (request: SafeTransportRequest) => Promise<SafeTransportResponse>;

export interface SafeFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly allowedPorts?: readonly number[];
  readonly headers?: Readonly<Record<string, string>>;
  /** Test seam: substitute the resolver. */
  readonly resolver?: AddressResolver;
  /** Test seam: substitute the transport. */
  readonly transport?: SafeTransport;
}

export interface SafeFetchResult {
  /** The URL the body actually came from, after redirects. */
  readonly url: string;
  readonly status: number;
  readonly contentType?: string;
  readonly body: Buffer;
  /** Every URL visited before the final one, in order. */
  readonly redirects: readonly string[];
}

export interface SafeTarget {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Vet one URL and return the address a connection to it may use.
 *
 * @throws SafeFetchError when the scheme, the port or any resolved address is
 *   refused.
 */
export async function resolveSafeTarget(
  rawUrl: string,
  options: {
    readonly allowedPorts?: readonly number[];
    readonly resolver?: AddressResolver;
  } = {},
): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("blocked_scheme", "not a URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("blocked_scheme", `${url.protocol} is not fetchable`);
  }

  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!allowedPorts.includes(port)) {
    throw new SafeFetchError("blocked_port", `port ${String(port)} is not permitted`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolver = options.resolver ?? defaultResolver;

  let addresses: readonly LookupAddress[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new SafeFetchError("dns_failed", `could not resolve ${hostname}: ${describe(error)}`);
  }
  if (addresses.length === 0) {
    throw new SafeFetchError("dns_failed", `${hostname} resolved to nothing`);
  }

  // Every record is judged, not just the one we would use: a name with one
  // public and one private answer must be refused outright.
  for (const candidate of addresses) {
    const denied = reasonAddressIsDenied(candidate.address);
    if (denied !== null) throw new SafeFetchError("blocked_address", denied);
  }

  const first = addresses[0];
  if (first === undefined)
    throw new SafeFetchError("dns_failed", `${hostname} resolved to nothing`);
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * Fetch a user-supplied URL under every rule above.
 *
 * @throws SafeFetchError - never a bare network error, so the caller always has a
 *   code to map onto an API error envelope.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = options.transport ?? defaultTransport;
  const deadline = Date.now() + timeoutMs;

  const redirects: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("timeout", "the request budget expired");

    const target = await resolveSafeTarget(current, {
      ...(options.allowedPorts === undefined ? {} : { allowedPorts: options.allowedPorts }),
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    });

    const response = await transport({
      url: target.url,
      address: target.address,
      family: target.family,
      headers: {
        host: target.url.host,
        "user-agent": "Aksharo/1.0 (+import)",
        accept: "*/*",
        ...(options.headers ?? {}),
      },
      timeoutMs: remaining,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      response.destroy();
      const location = response.headers["location"];
      if (location === undefined || location === "") {
        throw new SafeFetchError("request_failed", `${String(response.status)} with no Location`);
      }
      if (hop === maxRedirects) {
        throw new SafeFetchError(
          "too_many_redirects",
          `more than ${String(maxRedirects)} redirects`,
        );
      }
      redirects.push(current);
      current = new URL(location, target.url).toString();
      continue;
    }

    const body = await readCapped(response, maxBytes, deadline);
    const contentType = response.headers["content-type"];
    return {
      url: current,
      status: response.status,
      ...(contentType === undefined ? {} : { contentType }),
      body,
      redirects,
    };
  }

  throw new SafeFetchError("too_many_redirects", `more than ${String(maxRedirects)} redirects`);
}

async function readCapped(
  response: SafeTransportResponse,
  maxBytes: number,
  deadline: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      if (Date.now() > deadline) {
        throw new SafeFetchError("timeout", "the request budget expired mid-body");
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new SafeFetchError("too_large", `the body exceeded ${String(maxBytes)} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    response.destroy();
  }
  return Buffer.concat(chunks);
}

async function defaultResolver(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/**
 * `node:http`/`node:https` with the address pinned.
 *
 * `lookup` is overridden to hand back the address that was already vetted, which
 * is the whole point: the agent never performs a second DNS query, so there is no
 * window in which the answer can change. `servername` keeps TLS validating
 * against the name the user typed rather than against the literal IP.
 */
const defaultTransport: SafeTransport = async (input) =>
  new Promise<SafeTransportResponse>((resolve, reject) => {
    const secure = input.url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const port = input.url.port === "" ? (secure ? 443 : 80) : Number(input.url.port);

    const clientRequest = send(
      {
        protocol: input.url.protocol,
        host: input.url.hostname,
        port,
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        headers: input.headers,
        ...(secure ? { servername: input.url.hostname } : {}),
        lookup: (
          _hostname: string,
          _options: unknown,
          callback: (error: Error | null, address: string, family: number) => void,
        ) => {
          callback(null, input.address, input.family);
        },
      },
      (message: IncomingMessage) => {
        resolve({
          status: message.statusCode ?? 0,
          headers: message.headers as Record<string, string | undefined>,
          body: message,
          destroy: () => {
            message.destroy();
            clientRequest.destroy();
          },
        });
      },
    );

    clientRequest.setTimeout(input.timeoutMs, () => {
      clientRequest.destroy(new SafeFetchError("timeout", "the connection timed out"));
    });
    clientRequest.on("error", (error: unknown) => {
      reject(
        error instanceof SafeFetchError
          ? error
          : new SafeFetchError("request_failed", describe(error)),
      );
    });
    clientRequest.end();
  });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

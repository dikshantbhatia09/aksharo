import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { resolveSafeTarget, SafeFetchError } from "../net/safe-fetch.js";

import type { AddressResolver } from "../net/safe-fetch.js";
import type { IncomingMessage } from "node:http";

/**
 * The outbound half of webhook delivery (THREAT-MODEL T6, B14 §4).
 *
 * `common/net/safe-fetch.ts` (A06) already does the hard part — resolve, judge
 * every address, pin the one the socket connects to — but its `safeFetch` is a
 * `GET`-only client built for downloading a URL's bytes. A webhook delivery is
 * the opposite shape: a small `POST` body we already have, sent once, with no
 * redirect to follow (a webhook receiver that redirects is not configured
 * correctly, and following one would silently re-point the delivery at a host
 * the receiver's owner never registered). So this reuses
 * {@link resolveSafeTarget} for the address-pinning half and writes its own
 * minimal, POST-only transport rather than bending `safeFetch`'s
 * redirect/body-cap machinery to a shape it was not built for.
 *
 * Every call re-resolves and re-judges the endpoint's hostname — the same
 * "resolve, judge, pin" sequence `safeFetch` uses — so a webhook endpoint that
 * validated as public at creation time but has since been re-pointed at a
 * private address (DNS rebinding, or the owner's DNS simply changed) is refused
 * at delivery time too.
 */
export interface SendWebhookInput {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Test seam: substitute the resolver, same contract as `safeFetch`. */
  readonly resolver?: AddressResolver;
  /** Test seam: substitute the transport, so a unit test never opens a socket. */
  readonly transport?: WebhookTransport;
}

export interface SendWebhookResult {
  readonly status: number;
  readonly bodySnippet: string;
}

export interface WebhookTransportRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly timeoutMs: number;
}

export type WebhookTransport = (request: WebhookTransportRequest) => Promise<SendWebhookResult>;

const DEFAULT_TIMEOUT_MS = 10_000;
/** A receiver's response is never trusted for content; a small snippet is kept for the delivery log. */
const MAX_RESPONSE_BYTES = 4_096;

export async function sendWebhook(input: SendWebhookInput): Promise<SendWebhookResult> {
  const target = await resolveSafeTarget(input.url, {
    ...(input.resolver === undefined ? {} : { resolver: input.resolver }),
  });

  const transport = input.transport ?? defaultWebhookTransport;
  return transport({
    url: target.url,
    address: target.address,
    family: target.family,
    headers: input.headers,
    body: Buffer.from(input.body, "utf8"),
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/** `node:http`/`node:https`, address pinned exactly as `safe-fetch.ts`'s transport does. */
const defaultWebhookTransport: WebhookTransport = async (input) =>
  new Promise<SendWebhookResult>((resolve, reject) => {
    const secure = input.url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    const port = input.url.port === "" ? (secure ? 443 : 80) : Number(input.url.port);

    const clientRequest = send(
      {
        protocol: input.url.protocol,
        host: input.url.hostname,
        port,
        path: `${input.url.pathname}${input.url.search}`,
        method: "POST",
        headers: {
          ...input.headers,
          host: input.url.host,
          "content-length": String(input.body.byteLength),
        },
        ...(secure ? { servername: input.url.hostname } : {}),
        // Pinned: the same address `resolveSafeTarget` already vetted, never a
        // second DNS query — see `safe-fetch.ts`'s own transport for why.
        lookup: (
          _hostname: string,
          _options: unknown,
          callback: (error: Error | null, address: string, family: number) => void,
        ) => {
          callback(null, input.address, input.family);
        },
      },
      (message: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let total = 0;
        message.on("data", (chunk: Buffer) => {
          if (total >= MAX_RESPONSE_BYTES) return;
          const take = chunk.subarray(0, MAX_RESPONSE_BYTES - total);
          chunks.push(take);
          total += take.byteLength;
        });
        message.on("end", () => {
          resolve({
            status: message.statusCode ?? 0,
            bodySnippet: Buffer.concat(chunks).toString("utf8"),
          });
        });
        message.on("error", (error: Error) => {
          reject(new SafeFetchError("request_failed", error.message));
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
          : new SafeFetchError(
              "request_failed",
              error instanceof Error ? error.message : String(error),
            ),
      );
    });
    clientRequest.write(input.body);
    clientRequest.end();
  });

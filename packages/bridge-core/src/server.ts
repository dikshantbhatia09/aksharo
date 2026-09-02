import { createServer as createHttpsServer } from "node:https";

import { WebSocketServer, type WebSocket } from "ws";

import {
  BRIDGE_ERROR_CODES,
  BridgeRpcError,
  isBridgeMethod,
  JsonRpcRequestSchema,
  MAX_MESSAGE_BYTES,
  toJsonRpcError,
  UNAUTHENTICATED_METHODS,
  type BridgeMethod,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";
import {
  bearerMatches,
  extractBearer,
  isAllowedHost,
  isAllowedOrigin,
  LOCAL_NETWORK_ACCESS_HEADER,
  RateLimiter,
} from "./security.js";

import type { BridgeCertificate } from "./cert.js";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";

export const LOOPBACK_PORTS = [47831, 47832, 47833] as const;

export interface RpcContext {
  /** `undefined` until `session.exchange` has completed for this connection. */
  clientId?: string;
  scopes: readonly string[];
  remoteAddress: string;
}

export type RpcHandler = (
  method: BridgeMethod,
  params: unknown,
  context: RpcContext,
) => Promise<unknown>;

export interface BridgeServerOptions {
  readonly bearer: string;
  readonly cert: BridgeCertificate;
  readonly handleRpc: RpcHandler;
  readonly rateLimit?: { windowMs: number; max: number };
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface BridgeServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** Binds the first free port in {@link LOOPBACK_PORTS} to `127.0.0.1` only. */
export async function startLoopbackServer(
  options: BridgeServerOptions,
): Promise<BridgeServerHandle> {
  let lastError: unknown;
  for (const port of LOOPBACK_PORTS) {
    try {
      return await bindOnPort(port, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `no free loopback port in ${LOOPBACK_PORTS.join(",")}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function bindOnPort(port: number, options: BridgeServerOptions): Promise<BridgeServerHandle> {
  const limiter = new RateLimiter(options.rateLimit ?? { windowMs: 10_000, max: 60 });
  const log = options.log ?? (() => undefined);

  const httpServer = createHttpsServer(
    { cert: options.cert.certPem, key: options.cert.privateKeyPem },
    (req, res) => {
      void handleHttpRequest(req, res, port, options, limiter, log);
    },
  );

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  httpServer.on("upgrade", (req, socket, head) => {
    const check = runGuards(req, port, options, limiter);
    if (!check.ok) {
      socket.write(`HTTP/1.1 ${String(check.status)} ${check.reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      registerSocket(ws, req, options);
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: unknown): void => {
      httpServer.off("listening", onListening);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      resolve({
        port,
        close: () =>
          new Promise<void>((closeResolve) => {
            wss.close(() => {
              httpServer.close(() => closeResolve());
            });
          }),
      });
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, "127.0.0.1");
  });
}

interface GuardResult {
  ok: boolean;
  status: number;
  reason: string;
}

function ok(): GuardResult {
  return { ok: true, status: 200, reason: "OK" };
}
function fail(status: number, reason: string): GuardResult {
  return { ok: false, status, reason };
}

/** Bearer -> Host -> Origin -> rate limit, in that order (brief §2). */
function runGuards(
  req: IncomingMessage,
  port: number,
  options: BridgeServerOptions,
  limiter: RateLimiter,
): GuardResult {
  const bearer = extractBearer(req.headers.authorization);
  if (!bearerMatches(bearer, options.bearer)) return fail(401, "Unauthorized");
  if (!isAllowedHost(req.headers.host, port)) return fail(400, "Bad Request");

  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  // Non-browser loopback clients (a plugin's native host process, a CLI) send no
  // Origin at all; that is allowed. A browser or webview always sends one, so a
  // present-but-disallowed (including `null`) Origin is refused.
  if (origin !== undefined && !isAllowedOrigin(origin)) return fail(403, "Forbidden");

  const key = req.socket.remoteAddress ?? "unknown";
  if (!limiter.consume(key)) return fail(429, "Too Many Requests");

  return ok();
}

function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  options: BridgeServerOptions,
  limiter: RateLimiter,
  log: (line: Record<string, unknown>) => void,
): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  applyCors(res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const guard = runGuards(req, port, options, limiter);
  if (!guard.ok) {
    log({ evt: "bridge.http.rejected", status: guard.status, path: req.url });
    res.writeHead(guard.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "bridge/rejected", message: guard.reason } }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_MESSAGE_BYTES) {
      if (!res.headersSent) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { code: "bridge/too_large", message: "Message too large." } }),
        );
      }
      // Stop buffering further chunks but let the socket close naturally once
      // the client finishes writing — destroying it here races the response
      // flush and the client sees a reset instead of its 413.
      req.resume();
      return;
    }
    if (res.headersSent) return;
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    void (async () => {
      const context: RpcContext = {
        scopes: [],
        remoteAddress: req.socket.remoteAddress ?? "unknown",
      };
      const body = Buffer.concat(chunks).toString("utf8");
      const response = await dispatch(body, context, options);
      log({ evt: "bridge.http.request", path: req.url, requestId: response.id });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    })();
  });
}

function applyCors(res: ServerResponse, origin: string | undefined): void {
  if (origin !== undefined && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader(LOCAL_NETWORK_ACCESS_HEADER, "true");
    res.setHeader("Vary", "Origin");
  }
}

function registerSocket(ws: WebSocket, req: IncomingMessage, options: BridgeServerOptions): void {
  const context: RpcContext = { scopes: [], remoteAddress: req.socket.remoteAddress ?? "unknown" };
  // `ws`'s own `maxPayload` (set on the WebSocketServer) already closes an
  // oversized frame with 1009 at the protocol level before `message` fires; an
  // unhandled `error` event on an EventEmitter is a Node-level uncaught
  // exception, so this listener must exist even though the close path above
  // is the one exercised in practice.
  ws.on("error", () => {
    if (ws.readyState === 1 || ws.readyState === 0) ws.close(1011, "socket error");
  });
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : Buffer.from(raw as ArrayBuffer).toString("utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
      ws.close(1009, "message too large");
      return;
    }
    void dispatch(text, context, options).then((response) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(response));
    });
  });
}

async function dispatch(
  body: string,
  context: RpcContext,
  options: BridgeServerOptions,
): Promise<JsonRpcResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return errorResponse(null, BRIDGE_ERROR_CODES.parseError, "Invalid JSON.");
  }

  const requestResult = JsonRpcRequestSchema.safeParse(parsed);
  if (!requestResult.success) {
    return errorResponse(null, BRIDGE_ERROR_CODES.invalidRequest, "Invalid JSON-RPC request.");
  }
  const request: JsonRpcRequest = requestResult.data;

  if (!isBridgeMethod(request.method)) {
    return errorResponse(
      request.id ?? null,
      BRIDGE_ERROR_CODES.methodNotFound,
      `Unknown method: ${request.method}`,
    );
  }

  if (!UNAUTHENTICATED_METHODS.has(request.method) && context.clientId === undefined) {
    return errorResponse(
      request.id ?? null,
      BRIDGE_ERROR_CODES.notPaired,
      "Call session.exchange first.",
    );
  }

  try {
    const result = await options.handleRpc(request.method, request.params, context);
    return { jsonrpc: "2.0", id: request.id ?? null, result };
  } catch (error) {
    if (error instanceof BridgeRpcError) {
      return errorResponse(request.id ?? null, error.code, error.message, error.data);
    }
    return { jsonrpc: "2.0", id: request.id ?? null, error: toJsonRpcError(error) };
  }
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export type { HttpServer };

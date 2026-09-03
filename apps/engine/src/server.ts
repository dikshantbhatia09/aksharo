import { createServer as createHttpServer } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { bearerMatches, extractBearer, isAllowedHost, RateLimiter } from "@montaj/bridge-core";
import {
  AlignRequestSchema,
  CleanRequestSchema,
  ModelDeleteRequestSchema,
  ModelDownloadRequestSchema,
  ProbeRequestSchema,
  RenderRequestSchema,
  TranscribeRequestSchema,
  type HealthResponse,
  type ModelsResponse,
} from "@montaj/engine-client";

import { ModelManagerError } from "./model-manager.js";

import type { EngineBackend } from "./backends/types.js";
import type { DetectionResult } from "./detection.js";
import type { ModelManager } from "./model-manager.js";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64MB: generous for a JSON control message; media itself is passed by path, never inline.

export interface EngineServerOptions {
  readonly bearer: string;
  readonly backend: EngineBackend;
  readonly modelManager: ModelManager;
  readonly detection: DetectionResult;
  readonly startedAt: number;
  readonly log?: (line: Record<string, unknown>) => void;
  readonly rateLimit?: { windowMs: number; max: number };
  /** Fixed port for tests; omitted in production picks an ephemeral port (`listen(0, ...)`). */
  readonly port?: number;
}

export interface EngineServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** Starts the localhost-only HTTP/WS server (brief §1; THREAT-MODEL T22). Binds `127.0.0.1` only, on an ephemeral port unless `options.port` is given. */
export async function startEngineServer(options: EngineServerOptions): Promise<EngineServerHandle> {
  const limiter = new RateLimiter(options.rateLimit ?? { windowMs: 10_000, max: 120 });
  const log = options.log ?? (() => undefined);

  const httpServer = createHttpServer((req, res) => {
    void handleHttp(req, res, options, limiter, log);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const bearer = url.searchParams.get("bearer") ?? extractBearer(req.headers.authorization);
    if (!bearerMatches(bearer ?? undefined, options.bearer) || url.pathname !== "/transcribe") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      registerTranscribeSocket(ws, options);
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: unknown): void => {
      httpServer.off("listening", onListening);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
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
    httpServer.listen(options.port ?? 0, "127.0.0.1");
  });
}

interface RouteContext {
  readonly options: EngineServerOptions;
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: EngineServerOptions,
  limiter: RateLimiter,
  log: (line: Record<string, unknown>) => void,
): Promise<void> {
  const key = req.socket.remoteAddress ?? "unknown";
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  // `/health` is intentionally unauthenticated (mirrors model-server's `/healthz`):
  // a caller needs to know the engine is alive before it has a bearer to send,
  // and the response carries no user data, only versions/tier/backend.
  if (req.method === "GET" && path === "/health") {
    return respondJson(res, 200, await buildHealth(options));
  }

  if (!isAllowedHost(req.headers.host, req.socket.localPort ?? 0)) {
    return respondError(res, 400, "engine/bad_host", "Bad Request");
  }
  if (!bearerMatches(extractBearer(req.headers.authorization), options.bearer)) {
    return respondError(res, 401, "engine/unauthorized", "Unauthorized");
  }
  if (!limiter.consume(key)) {
    return respondError(res, 429, "engine/rate_limited", "Too Many Requests");
  }

  try {
    const body = await readJsonBody(req);
    const context: RouteContext = { options };
    const result = await dispatchRoute(req.method ?? "GET", path, body, context);
    log({ evt: "engine.http.request", path, method: req.method });
    respondJson(res, 200, result);
  } catch (error) {
    if (error instanceof RouteError) {
      respondError(res, error.status, error.code, error.message);
    } else if (error instanceof ModelManagerError) {
      // Every ModelManagerError is a well-formed client-facing condition (a
      // bad model id, a checksum failure, a disk-budget breach, a transient
      // download failure) — never a 500, so the desktop shell can show it.
      respondError(res, 400, `engine/${error.code}`, error.message);
    } else {
      log({
        evt: "engine.http.error",
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      respondError(res, 500, "engine/internal_error", "Internal Server Error");
    }
  }
}

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function dispatchRoute(
  method: string,
  path: string,
  body: unknown,
  context: RouteContext,
): Promise<unknown> {
  const { options } = context;

  if (method === "GET" && path === "/models") {
    return buildModelsResponse(options.modelManager);
  }
  if (method === "POST" && path === "/models/download") {
    const parsed = parseOrThrow(ModelDownloadRequestSchema, body);
    await options.modelManager.download(parsed.modelId);
    return { ok: true };
  }
  if (method === "POST" && path === "/models/delete") {
    const parsed = parseOrThrow(ModelDeleteRequestSchema, body);
    await options.modelManager.delete(parsed.modelId);
    return { ok: true };
  }
  if (method === "POST" && path === "/transcribe") {
    const parsed = parseOrThrow(TranscribeRequestSchema, body);
    return options.backend.transcribe(parsed);
  }
  if (method === "POST" && path === "/align") {
    const parsed = parseOrThrow(AlignRequestSchema, body);
    return options.backend.align(parsed);
  }
  if (method === "POST" && path === "/clean") {
    const parsed = parseOrThrow(CleanRequestSchema, body);
    return options.backend.clean(parsed);
  }
  if (method === "POST" && path === "/probe") {
    const parsed = parseOrThrow(ProbeRequestSchema, body);
    return options.backend.probe(parsed);
  }
  if (method === "POST" && path === "/render") {
    const parsed = parseOrThrow(RenderRequestSchema, body);
    return options.backend.render(parsed);
  }

  throw new RouteError(404, "engine/not_found", `No route for ${method} ${path}`);
}

function parseOrThrow<T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success || result.data === undefined) {
    throw new RouteError(400, "engine/invalid_request", "Request body failed validation.");
  }
  return result.data;
}

async function buildHealth(options: EngineServerOptions): Promise<HealthResponse> {
  const modelsMissing = await options.modelManager.modelsMissing();
  return {
    status: "ok",
    backend: options.backend.kind,
    tier: options.detection.tier,
    tierReason: options.detection.tierReason,
    engineVersions: options.backend.engineVersions(),
    modelsMissing,
    uptimeS: Number(((Date.now() - options.startedAt) / 1000).toFixed(3)),
  };
}

async function buildModelsResponse(modelManager: ModelManager): Promise<ModelsResponse> {
  const models = await modelManager.listStatuses();
  const diskUsageBytes = await modelManager.diskUsageBytes();
  return {
    models,
    diskUsageBytes,
    diskBudgetBytes: modelManager.diskBudgetBytesPublic(),
    defaultModel: modelManager.defaultModelId(),
    fallbackModel: modelManager.fallbackModelId(),
  };
}

function registerTranscribeSocket(ws: WebSocket, options: EngineServerOptions): void {
  ws.on("error", () => {
    if (ws.readyState === 1 || ws.readyState === 0) ws.close(1011, "socket error");
  });
  ws.on("message", (raw: Buffer) => {
    void (async () => {
      const parsed = TranscribeRequestSchema.safeParse(JSON.parse(raw.toString("utf8")));
      if (!parsed.success) {
        ws.send(
          JSON.stringify({
            kind: "error",
            requestId: "unknown",
            error: { code: "engine/invalid_request", message: "Invalid transcribe request." },
          }),
        );
        return;
      }
      for await (const message of options.backend.transcribeStream(parsed.data)) {
        if (ws.readyState !== 1) break;
        ws.send(JSON.stringify(message));
      }
    })();
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondError(res: ServerResponse, status: number, code: string, message: string): void {
  respondJson(res, status, { error: { code, message } });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw new RouteError(413, "engine/too_large", "Request body too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RouteError(400, "engine/invalid_json", "Invalid JSON body.");
  }
}

export type { HttpServer };

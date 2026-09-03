import WebSocket from "ws";

import {
  AlignRequestSchema,
  AlignResponseSchema,
  CleanRequestSchema,
  CleanResponseSchema,
  ErrorEnvelopeSchema,
  HealthResponseSchema,
  ModelDeleteRequestSchema,
  ModelDownloadRequestSchema,
  ModelsResponseSchema,
  ProbeRequestSchema,
  ProbeResponseSchema,
  RenderRequestSchema,
  RenderResponseSchema,
  TranscribeRequestSchema,
  TranscribeResponseSchema,
  TranscribeStreamMessageSchema,
} from "./schemas.js";

import type {
  AlignRequest,
  AlignResponse,
  CleanRequest,
  CleanResponse,
  HealthResponse,
  ModelsResponse,
  ProbeRequest,
  ProbeResponse,
  RenderRequest,
  RenderResponse,
  TranscribeRequest,
  TranscribeResponse,
  TranscribeStreamMessage,
} from "./schemas.js";

/**
 * Typed client for the local engine sidecar's HTTP/WS contract (brief §1),
 * shared verbatim by `apps/desktop` and `apps/web` so neither hand-rolls a
 * second parser for the same wire shapes. Every method validates the
 * response with the matching Zod schema before returning it — a malformed or
 * out-of-version response from a mismatched sidecar build fails loudly here
 * rather than propagating a bad shape into the editor.
 */

export class EngineClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EngineClientError";
  }
}

export interface EngineClientOptions {
  readonly baseUrl: string;
  readonly bearer: string;
  readonly fetchImpl?: typeof fetch;
}

export class EngineClient {
  private readonly baseUrl: string;
  private readonly bearer: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.bearer = options.bearer;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<HealthResponse> {
    const body = await this.request("GET", "/health");
    return HealthResponseSchema.parse(body);
  }

  async models(): Promise<ModelsResponse> {
    const body = await this.request("GET", "/models");
    return ModelsResponseSchema.parse(body);
  }

  async downloadModel(modelId: string): Promise<void> {
    await this.request("POST", "/models/download", ModelDownloadRequestSchema.parse({ modelId }));
  }

  async deleteModel(modelId: string): Promise<void> {
    await this.request("POST", "/models/delete", ModelDeleteRequestSchema.parse({ modelId }));
  }

  async transcribe(input: TranscribeRequest): Promise<TranscribeResponse> {
    const body = await this.request("POST", "/transcribe", TranscribeRequestSchema.parse(input));
    return TranscribeResponseSchema.parse(body);
  }

  async align(input: AlignRequest): Promise<AlignResponse> {
    const body = await this.request("POST", "/align", AlignRequestSchema.parse(input));
    return AlignResponseSchema.parse(body);
  }

  async clean(input: CleanRequest): Promise<CleanResponse> {
    const body = await this.request("POST", "/clean", CleanRequestSchema.parse(input));
    return CleanResponseSchema.parse(body);
  }

  async probe(input: ProbeRequest): Promise<ProbeResponse> {
    const body = await this.request("POST", "/probe", ProbeRequestSchema.parse(input));
    return ProbeResponseSchema.parse(body);
  }

  async render(input: RenderRequest): Promise<RenderResponse> {
    const body = await this.request("POST", "/render", RenderRequestSchema.parse(input));
    return RenderResponseSchema.parse(body);
  }

  /**
   * Opens the `/transcribe` streaming WS and yields validated partial/done/error
   * frames (brief §1: "chunked, VAD-aligned, streaming partials over WS").
   * The socket is authenticated with the same bearer, sent as a query param
   * because WS clients cannot set an `Authorization` header on the handshake.
   */
  async *transcribeStream(input: TranscribeRequest): AsyncGenerator<TranscribeStreamMessage> {
    const url = `${this.wsUrl()}/transcribe?bearer=${encodeURIComponent(this.bearer)}`;
    const ws = new WebSocket(url);
    const queue: TranscribeStreamMessage[] = [];
    let closed = false;
    let error: Error | undefined;
    let resolveNext: (() => void) | undefined;

    ws.on("open", () => ws.send(JSON.stringify(TranscribeRequestSchema.parse(input))));
    ws.on("message", (raw: Buffer) => {
      const parsed = TranscribeStreamMessageSchema.safeParse(JSON.parse(raw.toString("utf8")));
      if (parsed.success) queue.push(parsed.data);
      resolveNext?.();
    });
    ws.on("close", () => {
      closed = true;
      resolveNext?.();
    });
    ws.on("error", (err: Error) => {
      error = err;
      resolveNext?.();
    });

    try {
      for (;;) {
        while (queue.length > 0) {
          const message = queue.shift();
          if (message !== undefined) yield message;
          if (message?.kind === "done" || message?.kind === "error") return;
        }
        if (error !== undefined) throw error;
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }

  private wsUrl(): string {
    return this.baseUrl.replace(/^http/, "ws");
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = ErrorEnvelopeSchema.safeParse(json);
      if (envelope.success) {
        throw new EngineClientError(
          envelope.data.error.message,
          envelope.data.error.code,
          response.status,
        );
      }
      throw new EngineClientError(
        `engine request failed: ${String(response.status)}`,
        "engine/http_error",
        response.status,
      );
    }
    return json;
  }
}

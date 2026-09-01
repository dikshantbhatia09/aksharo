import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";

import {
  normaliseRequestId,
  REQUEST_ID_HEADER,
  RequestContext,
  type RequestContextStore,
} from "../request-context.js";
import { REDACT_PATHS, redactLogObject } from "./redaction.js";

import type { NextFunction, Request, Response } from "express";
import type { Options as PinoHttpOptions } from "pino-http";

/**
 * Establish the request context before anything else touches the request.
 *
 * The id is reused from `x-request-id` when an edge proxy or a caller supplied a
 * well-formed one, so a trace survives the hop; otherwise a ULID is minted. It is
 * echoed on the response because the error envelope quotes it (CONTRACTS §8) and a
 * user reporting a failure should be able to read it off the network tab.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = (req as { id?: unknown }).id ?? req.headers[REQUEST_ID_HEADER];
  const requestId = normaliseRequestId(incoming);

  (req as { id?: string }).id = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  const store: RequestContextStore = { requestId };
  RequestContext.run(store, () => {
    next();
  });
}

/** pino-http options: JSON in production, human-readable when a TTY is attached. */
export function pinoHttpOptions(nodeEnv: string | undefined): PinoHttpOptions {
  const isProduction = nodeEnv === "production";
  return {
    level: process.env["LOG_LEVEL"] ?? (nodeEnv === "test" ? "silent" : "info"),
    // The context middleware has already put the id on the request; agreeing with
    // it keeps `req.id`, the response header and the error envelope identical.
    genReqId: (req) =>
      normaliseRequestId((req as { id?: unknown }).id ?? req.headers[REQUEST_ID_HEADER]),
    redact: { paths: [...REDACT_PATHS], censor: "[redacted]" },
    formatters: { log: redactLogObject },
    customProps: () => {
      const store = RequestContext.get();
      return {
        requestId: store?.requestId ?? "unknown",
        ...(store?.userId === undefined ? {} : { userId: store.userId }),
        ...(store?.workspaceId === undefined ? {} : { workspaceId: store.workspaceId }),
      };
    },
    // Health probes would otherwise dominate the log volume.
    autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/health/ready" },
    serializers: {
      req: (req: { id: string; method: string; url: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    transport: isProduction ? undefined : { target: "pino/file", options: { destination: 1 } },
  };
}

/**
 * Structured logging with request-id correlation and redaction.
 *
 * `nestjs-pino` replaces Nest's own logger, so `new Logger(...)` calls in existing
 * modules keep working and start emitting JSON with the request id attached.
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: pinoHttpOptions(process.env["NODE_ENV"]),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes("*path");
  }
}

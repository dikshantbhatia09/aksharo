import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

import { RequestContext } from "../request-context.js";
import { AppException, codeForStatus, ERROR_CODES, type ErrorCode } from "./error-codes.js";

import type { Response } from "express";

/** The wire shape of every error the API returns (CONTRACTS §8). */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly requestId: string;
  };
}

interface Mapped {
  status: number;
  code: ErrorCode | string;
  message: string;
  details?: unknown;
  /** 5xx and unrecognised throwables are logged with their stack. */
  logStack: boolean;
}

/** Prisma's error codes, mapped to ours. Anything else is an internal error. */
function mapPrisma(error: Prisma.PrismaClientKnownRequestError): Mapped | undefined {
  switch (error.code) {
    case "P2002":
      return {
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.conflict,
        message: "A record with these values already exists.",
        // `meta.target` is a column list, not user data, so it is safe to return
        // and it is exactly what a client needs to point at the offending field.
        details:
          error.meta?.["target"] === undefined ? undefined : { fields: error.meta["target"] },
        logStack: false,
      };
    case "P2025":
      return {
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.notFound,
        message: "The requested record does not exist.",
        logStack: false,
      };
    case "P2003":
      return {
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.conflict,
        message: "A related record is missing or still referenced.",
        logStack: false,
      };
    default:
      return undefined;
  }
}

function mapHttpException(error: HttpException): Mapped {
  const status = error.getStatus();
  const body: unknown = error.getResponse();

  let message = error.message;
  let details: unknown;

  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record["message"] === "string") message = record["message"];
    // Nest's built-in pipes put an array of strings here.
    else if (Array.isArray(record["message"])) details = { issues: record["message"] };
    if (record["details"] !== undefined) details = record["details"];
  } else if (typeof body === "string") {
    message = body;
  }

  return {
    status,
    code: codeForStatus(status),
    message,
    details,
    logStack: status >= HttpStatus.INTERNAL_SERVER_ERROR,
  };
}

function map(exception: unknown): Mapped {
  if (exception instanceof AppException) {
    return {
      status: exception.httpStatus,
      code: exception.code,
      message: exception.message,
      details: exception.details,
      logStack: exception.httpStatus >= HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }

  if (exception instanceof ZodError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.validationFailed,
      message: "Request validation failed.",
      details: { issues: exception.issues },
      logStack: false,
    };
  }

  if (exception instanceof HttpException) return mapHttpException(exception);

  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = mapPrisma(exception);
    if (mapped !== undefined) return mapped;
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ERROR_CODES.internal,
    // Never the underlying message: it leaks queries, paths and provider replies.
    message: "An unexpected error occurred.",
    logStack: true,
  };
}

/**
 * Turns every throwable into the CONTRACTS §8 envelope
 * `{ error: { code, message, details?, requestId } }`.
 *
 * Registered globally in `main.ts`, so a 404 from the router and a rejected
 * promise three services deep produce the same shape — which is what makes
 * `packages/api-client` able to handle errors generically.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = map(exception);
    const requestId = RequestContext.requestId();

    if (mapped.logStack) {
      this.logger.error(
        { err: exception, code: mapped.code, status: mapped.status },
        "unhandled exception",
      );
    }

    const envelope: ErrorEnvelope = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
        requestId,
      },
    };

    // `headersSent` guards the streaming responses that A21 will add.
    if (response.headersSent) return;
    response.status(mapped.status).json(envelope);
  }
}

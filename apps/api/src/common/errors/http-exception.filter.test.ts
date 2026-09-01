import { BadRequestException, HttpException, HttpStatus, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { RequestContext } from "../request-context.js";
import { AppException, ERROR_CODES } from "./error-codes.js";
import { HttpExceptionFilter } from "./http-exception.filter.js";

import type { ErrorEnvelope } from "./http-exception.filter.js";
import type { ArgumentsHost } from "@nestjs/common";

interface Captured {
  status: number;
  body: ErrorEnvelope;
  headersSent: boolean;
}

function hostWith(headersSent = false): { host: ArgumentsHost; captured: Captured } {
  const captured: Captured = {
    status: 0,
    body: { error: { code: "", message: "", requestId: "" } },
    headersSent,
  };
  const response = {
    get headersSent() {
      return captured.headersSent;
    },
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: ErrorEnvelope) {
      captured.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

function render(exception: unknown, requestId = "req-test-000001"): Captured {
  const { host, captured } = hostWith();
  RequestContext.run({ requestId }, () => {
    new HttpExceptionFilter().catch(exception, host);
  });
  return captured;
}

describe("HttpExceptionFilter", () => {
  it("renders an AppException into the CONTRACTS §8 envelope", () => {
    const captured = render(
      new AppException(ERROR_CODES.edgConflict, "Revision moved on.", HttpStatus.CONFLICT, {
        latestRevision: 42,
      }),
    );

    expect(captured.status).toBe(409);
    expect(captured.body).toEqual({
      error: {
        code: "edg/conflict",
        message: "Revision moved on.",
        details: { latestRevision: 42 },
        requestId: "req-test-000001",
      },
    });
  });

  it("omits `details` entirely when there are none", () => {
    const captured = render(new NotFoundException("No such project."));
    expect(captured.body.error).toEqual({
      code: ERROR_CODES.notFound,
      message: "No such project.",
      requestId: "req-test-000001",
    });
    expect("details" in captured.body.error).toBe(false);
  });

  it("maps a plain HttpException by status", () => {
    expect(render(new BadRequestException("Bad.")).body.error.code).toBe(ERROR_CODES.badRequest);
    expect(render(new HttpException("Nope.", HttpStatus.FORBIDDEN)).body.error.code).toBe(
      ERROR_CODES.forbidden,
    );
  });

  it("lifts the message array Nest's built-in pipes produce into details", () => {
    const captured = render(new BadRequestException({ message: ["title must be a string"] }));
    expect(captured.body.error.details).toEqual({ issues: ["title must be a string"] });
  });

  it("renders a raw ZodError as a validation failure", () => {
    const parsed = z.object({ title: z.string() }).safeParse({ title: 1 });
    const captured = render(parsed.success ? new Error("unreachable") : parsed.error);

    expect(captured.status).toBe(400);
    expect(captured.body.error.code).toBe(ERROR_CODES.validationFailed);
    expect(captured.body.error.details).toHaveProperty("issues");
  });

  it("maps Prisma's unique-violation to a conflict naming the fields", () => {
    const captured = render(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: ["series", "fiscal_year", "number"] },
      }),
    );

    expect(captured.status).toBe(409);
    expect(captured.body.error.code).toBe(ERROR_CODES.conflict);
    expect(captured.body.error.details).toEqual({
      fields: ["series", "fiscal_year", "number"],
    });
  });

  it("maps Prisma's missing-record to a 404 and a foreign key to a conflict", () => {
    const notFound = render(
      new Prisma.PrismaClientKnownRequestError("not found", { code: "P2025", clientVersion: "6" }),
    );
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe(ERROR_CODES.notFound);

    const fk = render(
      new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "6" }),
    );
    expect(fk.status).toBe(409);
  });

  it("hides the detail of an unknown Prisma error behind common/internal", () => {
    const captured = render(
      new Prisma.PrismaClientKnownRequestError("connection pool timeout at 10.0.0.5", {
        code: "P2024",
        clientVersion: "6",
      }),
    );
    expect(captured.status).toBe(500);
    expect(captured.body.error.code).toBe(ERROR_CODES.internal);
    expect(captured.body.error.message).toBe("An unexpected error occurred.");
  });

  it("never leaks the message of an unexpected throwable", () => {
    const captured = render(new Error("SELECT * FROM users WHERE token = 'sk_live_abc'"));

    expect(captured.status).toBe(500);
    expect(captured.body.error.code).toBe(ERROR_CODES.internal);
    expect(captured.body.error.message).toBe("An unexpected error occurred.");
    expect(JSON.stringify(captured.body)).not.toContain("sk_live_abc");
  });

  it("falls back to requestId `unknown` outside a request", () => {
    const { host, captured } = hostWith();
    new HttpExceptionFilter().catch(new NotFoundException(), host);
    expect(captured.body.error.requestId).toBe("unknown");
  });

  it("writes nothing once the response has started streaming", () => {
    const { host, captured } = hostWith(true);
    const json = vi.fn();
    new HttpExceptionFilter().catch(new Error("late"), host);
    expect(captured.status).toBe(0);
    expect(json).not.toHaveBeenCalled();
  });
});

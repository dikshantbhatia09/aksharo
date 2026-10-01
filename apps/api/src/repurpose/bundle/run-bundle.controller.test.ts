import { PassThrough } from "node:stream";

import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { PublicRunDownloadController, contentDisposition } from "./run-bundle.controller.js";
import { AppException } from "../../common/errors/error-codes.js";

import type { OpenedRunBundle, RunBundleService } from "./run-bundle.service.js";
import type { Response } from "express";

/** A writable stand-in for an Express response that records what was set. */
function fakeResponse(): {
  readonly response: Response;
  readonly headers: Map<string, string>;
  readonly body: () => string;
  status: number;
  sent: string;
} {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  const headers = new Map<string, string>();
  const state = {
    headers,
    status: 0,
    sent: "",
    body: () => Buffer.concat(chunks).toString("utf8"),
    response: undefined as unknown as Response,
  };
  const response = Object.assign(sink, {
    status(code: number) {
      state.status = code;
      return response;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    type(kind: string) {
      headers.set("content-type", kind);
      return response;
    },
    send(text: string) {
      state.sent = text;
      return response;
    },
  });
  state.response = response as unknown as Response;
  return state;
}

const ENV = { WEB_ORIGIN: "https://aksharo.test" } as unknown as Env;

describe("contentDisposition", () => {
  it("gives an ASCII name and the real one", () => {
    expect(contentDisposition('Q&A "Live".zip')).toBe(
      `attachment; filename="Q&A _Live_.zip"; filename*=UTF-8''Q%26A%20%22Live%22.zip`,
    );
    expect(contentDisposition("हिंदी.zip")).toMatch(/^attachment; filename="_+\.zip"; filename\*=UTF-8''%E0/);
  });
});

describe("PublicRunDownloadController", () => {
  it("sends the ZIP with its length and name, and frees its place after", async () => {
    const release = vi.fn();
    const opened: OpenedRunBundle = {
      filename: "Talk.zip",
      totalBytes: 5,
      files: 1,
      stream: (async function* () {
        yield Buffer.from("hello");
      })(),
      release,
    };
    const controller = new PublicRunDownloadController(
      { open: async () => opened } as unknown as RunBundleService,
      ENV,
    );
    const fake = fakeResponse();
    await controller.download("t".repeat(43), fake.response);

    expect(fake.status).toBe(HttpStatus.OK);
    expect(fake.headers.get("content-type")).toBe("application/zip");
    expect(fake.headers.get("content-length")).toBe("5");
    expect(fake.headers.get("content-disposition")).toContain('filename="Talk.zip"');
    expect(fake.headers.get("cache-control")).toBe("no-store");
    expect(fake.body()).toBe("hello");
    expect(release).toHaveBeenCalled();
  });

  it("shows a page that leads back, not an error body, for a spent link", async () => {
    const controller = new PublicRunDownloadController(
      {
        open: async () => {
          throw new AppException(
            "repurpose/download_expired",
            "This download link has expired. <b>Start</b> again.",
            HttpStatus.NOT_FOUND,
          );
        },
      } as unknown as RunBundleService,
      ENV,
    );
    const fake = fakeResponse();
    await controller.download("spent", fake.response);

    expect(fake.status).toBe(HttpStatus.NOT_FOUND);
    expect(fake.headers.get("content-type")).toBe("html");
    expect(fake.sent).toContain("This download link has expired.");
    // The message is escaped, and the way back is the web app.
    expect(fake.sent).toContain("&#60;b&#62;Start&#60;/b&#62;");
    expect(fake.sent).toContain('href="https://aksharo.test/repurpose"');
  });

  it("cuts the response and frees its place when a file cannot be read part way", async () => {
    const release = vi.fn();
    const opened: OpenedRunBundle = {
      filename: "Talk.zip",
      totalBytes: 100,
      files: 1,
      stream: (async function* () {
        yield Buffer.from("partial");
        throw new Error("store went away");
      })(),
      release,
    };
    const controller = new PublicRunDownloadController(
      { open: async () => opened } as unknown as RunBundleService,
      ENV,
    );
    const fake = fakeResponse();
    await controller.download("t".repeat(43), fake.response);
    expect((fake.response as unknown as PassThrough).destroyed).toBe(true);
    expect(release).toHaveBeenCalled();
  });
});

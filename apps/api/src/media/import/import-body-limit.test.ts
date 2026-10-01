import { Body, Controller, Param, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyImportBodyLimit } from "./import-body-limit.js";
import { HttpExceptionFilter } from "../../common/errors/http-exception.filter.js";

import type { INestApplication } from "@nestjs/common";

/**
 * Through the real HTTP parser (2026-10-01 review): the unit tests of the run
 * service call it with an object, so none of them could see that Express's
 * 100 kB default refused a caption file long before the service's own 2 MB cap.
 */

@Controller("repurpose/runs")
class RunsProbe {
  @Post()
  create(@Body() body: { setup?: { captions?: { content?: string } } }) {
    return { bytes: Buffer.byteLength(body.setup?.captions?.content ?? "", "utf8") };
  }

  @Post(":runId/cancel")
  cancel(@Param("runId") runId: string, @Body() body: { note?: string }) {
    return { runId, note: body.note?.length ?? 0 };
  }
}

@Controller("projects/:projectId")
class ImportProbe {
  @Post("import")
  importSubtitles(@Body() body: { content?: string }) {
    return { bytes: Buffer.byteLength(body.content ?? "", "utf8") };
  }
}

/** A realistic SRT of about `targetBytes`, Devanagari text and CRLF line ends. */
function srtOf(targetBytes: number): string {
  const cues: string[] = [];
  let size = 0;
  for (let n = 1; size < targetBytes; n += 1) {
    const cue = `${String(n)}\r\n00:00:01,000 --> 00:00:02,000\r\nनमस्ते दोस्तों, आज हम बात करेंगे\r\n\r\n`;
    cues.push(cue);
    size += Buffer.byteLength(cue, "utf8");
  }
  return cues.join("");
}

describe("applyImportBodyLimit", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RunsProbe, ImportProbe],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    applyImportBodyLimit(app);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("takes a 1.5 MB SRT on POST /repurpose/runs", async () => {
    const content = srtOf(1.5 * 1024 * 1024);
    const response = await request(app.getHttpServer())
      .post("/repurpose/runs")
      .send({ setup: { captions: { from: "file", kind: "srt", content } } });
    expect(response.status).toBe(201);
    expect(response.body.bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("takes a 1.9 MB SRT on the editor's POST /projects/:projectId/import", async () => {
    const content = srtOf(1.9 * 1024 * 1024);
    const response = await request(app.getHttpServer())
      .post("/projects/01PROJECT/import")
      .send({ kind: "srt", content });
    expect(response.status).toBe(201);
    expect(response.body.bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("answers an oversized body with 413 import/too_large, not 500", async () => {
    const content = "a".repeat(4 * 1024 * 1024);
    const response = await request(app.getHttpServer())
      .post("/repurpose/runs")
      .send({ setup: { captions: { from: "file", kind: "srt", content } } });
    expect(response.status).toBe(413);
    expect(JSON.stringify(response.body)).toContain("import/too_large");
  });

  it("keeps the 100 kB default on every other route under /repurpose/runs", async () => {
    const response = await request(app.getHttpServer())
      .post("/repurpose/runs/01RUN/cancel")
      .send({ note: "a".repeat(200 * 1024) });
    // Refused by the adapter's own 100 kB parser, untranslated (its 500 is the
    // pre-existing behaviour on every ordinary route): the point is that this
    // wrapper did not parse it with the raised limit.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).not.toContain("import/too_large");

    const small = await request(app.getHttpServer())
      .post("/repurpose/runs/01RUN/cancel")
      .send({ note: "fine" });
    expect(small.status).toBe(201);
    expect(small.body).toEqual({ runId: "01RUN", note: 4 });
  });
});

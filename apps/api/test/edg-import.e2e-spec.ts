/**
 * `POST /projects/{id}/edg/import` (brief C04 §3): the API side of the
 * desktop's "Upload to cloud" — a whole EDG v2 document, written verbatim as
 * revision 1 of a project that has none yet. Against a real PostgreSQL,
 * exactly like `edg.e2e-spec.ts`, because the thing under test is the
 * database's behaviour: a fresh project has no document row until this call,
 * and a second call against the same project must not silently overwrite it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@montaj/edg";
import type { EdgHot, Segment } from "@montaj/edg/schemas";
import { seqBetween } from "@montaj/edg/seq";

import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { createEdgTestContext, type EdgTestContext } from "./edg-harness.js";

const available = isDatabaseAvailable();
if (!available) console.warn(`[edg-import.e2e] skipped: ${skipReason}`);

interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

describe.skipIf(!available)("EDG import (upload to cloud)", () => {
  let ctx: EdgTestContext;
  let base: string;

  beforeAll(async () => {
    const created = await createEdgTestContext();
    if (created === null) throw new Error("EDG import suite could not start");
    ctx = created;
    base = `http://127.0.0.1:${String(ctx.port)}`;
  }, 180_000);

  afterAll(async () => {
    await ctx.stop();
  });

  afterEach(async () => {
    await ctx.reset();
  });

  async function call<T = unknown>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      ...(payload === undefined ? {} : { body: payload }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as T };
  }

  /** A bare project — no transcript, no EDG document — as a fresh "local project" upload target. */
  async function createEmptyProject(): Promise<string> {
    const projectId = newId();
    await ctx.prisma.project.create({
      data: {
        id: projectId,
        workspaceId: ctx.workspaceId,
        title: "Uploaded from desktop",
        aspect: "r9x16",
        sourceLanguage: "hi-Latn",
        scripts: ["roman"],
        createdBy: ctx.userId,
      },
    });
    return projectId;
  }

  function localDocument(projectId: string): { hot: EdgHot; segments: Segment[] } {
    const wordId = "0:0" as Segment["startWordId"];
    const segmentId = newId();
    const hot: EdgHot = {
      meta: { edgId: newId(), projectId, revision: 0, schemaVersion: 2 },
      media: [],
      transcript: { transcriptId: newId(), revision: 1, language: "hi-Latn", scripts: ["roman"] },
      canvas: { aspect: "9:16", width: 1080, height: 1920 },
      styles: { defaultStyleId: "clean-bold" },
    };
    const segments: Segment[] = [
      {
        id: segmentId,
        seq: seqBetween(),
        startWordId: wordId,
        endWordId: wordId,
        startMs: 0,
        endMs: 400,
      } as Segment,
    ];
    return { hot, segments };
  }

  it("writes the document as revision 1 of a project that has none", async () => {
    const projectId = await createEmptyProject();
    const { hot, segments } = localDocument(projectId);

    const result = await call<{ edgId: string; revision: number; segments: number }>(
      "POST",
      `/projects/${projectId}/edg/import`,
      { token: ctx.token(), body: { hot, segments } },
    );

    expect(result.status).toBe(200);
    expect(result.body.revision).toBe(1);
    expect(result.body.segments).toBe(1);

    const document = await ctx.prisma.edgDocument.findUniqueOrThrow({
      where: { id: result.body.edgId },
    });
    expect(document.projectId).toBe(projectId);
    expect(document.revision).toBe(1);

    // The document read back through the normal surface agrees.
    const read = await call<{ hot: { transcript: { language: string } } }>(
      "GET",
      `/projects/${projectId}/edg`,
      { token: ctx.token("viewer") },
    );
    expect(read.status).toBe(200);
    expect(read.body.hot.transcript.language).toBe("hi-Latn");
  });

  it("refuses to import onto a project that already has a document", async () => {
    const project = await ctx.seed();
    const { hot, segments } = localDocument(project.projectId);

    const result = await call<{ error: { code: string } }>(
      "POST",
      `/projects/${project.projectId}/edg/import`,
      { token: ctx.token(), body: { hot, segments } },
    );

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("edg/already_imported");
  });

  it("hides another workspace's project behind a 404", async () => {
    const projectId = await createEmptyProject();
    const { hot, segments } = localDocument(projectId);

    const result = await call<{ error: { code: string } }>(
      "POST",
      `/projects/${projectId}/edg/import`,
      { token: ctx.token("owner", ctx.otherWorkspaceId), body: { hot, segments } },
    );

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("common/not_found");
  });

  it("refuses a write from a viewer", async () => {
    const projectId = await createEmptyProject();
    const { hot, segments } = localDocument(projectId);

    const result = await call<{ error: { code: string } }>(
      "POST",
      `/projects/${projectId}/edg/import`,
      { token: ctx.token("viewer"), body: { hot, segments } },
    );

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("common/forbidden");
  });

  it("rejects a document with no segments", async () => {
    const projectId = await createEmptyProject();
    const { hot } = localDocument(projectId);

    const result = await call<{ error: { code: string } }>(
      "POST",
      `/projects/${projectId}/edg/import`,
      { token: ctx.token(), body: { hot, segments: [] } },
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("common/validation_failed");
  });
});

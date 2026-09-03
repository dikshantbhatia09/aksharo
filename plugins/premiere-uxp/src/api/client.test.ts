import { describe, expect, it } from "vitest";

import { getProjectEdgSegments, getProjectTranscript, getStyles } from "./client.js";

import type { HttpGetClient } from "./client.js";

function mockHttp(response: unknown): {
  http: HttpGetClient;
  calls: [string, Record<string, string>][];
} {
  const calls: [string, Record<string, string>][] = [];
  return {
    calls,
    http: {
      async getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
        calls.push([url, headers]);
        return response as T;
      },
    },
  };
}

const OPTIONS_BASE = { apiOrigin: "https://api.aksharo.ai", sessionToken: "sess-token-1" };

describe("getStyles", () => {
  it("GETs /styles with a bearer auth header", async () => {
    const { http, calls } = mockHttp([{ presetId: "system-1", source: "system" }]);
    const result = await getStyles({ ...OPTIONS_BASE, http });
    expect(result).toEqual([{ presetId: "system-1", source: "system" }]);
    expect(calls).toEqual([
      ["https://api.aksharo.ai/styles", { Authorization: "Bearer sess-token-1" }],
    ]);
  });
});

describe("getProjectTranscript", () => {
  it("GETs /projects/{id}/transcript, URL-encoding the project id", async () => {
    const { http, calls } = mockHttp({
      transcriptId: "t1",
      revision: 3,
      language: "en",
      chunks: [],
    });
    const result = await getProjectTranscript({ ...OPTIONS_BASE, http }, "proj a/b");
    expect(result.transcriptId).toBe("t1");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one HTTP call");
    expect(call[0]).toBe("https://api.aksharo.ai/projects/proj%20a%2Fb/transcript");
    expect(call[1]).toEqual({ Authorization: "Bearer sess-token-1" });
  });
});

describe("getProjectEdgSegments", () => {
  it("GETs /projects/{id}/edg/segments", async () => {
    const { http, calls } = mockHttp({ revision: 7, segments: [] });
    const result = await getProjectEdgSegments({ ...OPTIONS_BASE, http }, "proj-1");
    expect(result).toEqual({ revision: 7, segments: [] });
    const call = calls[0];
    if (!call) throw new Error("expected one HTTP call");
    expect(call[0]).toBe("https://api.aksharo.ai/projects/proj-1/edg/segments");
  });
});

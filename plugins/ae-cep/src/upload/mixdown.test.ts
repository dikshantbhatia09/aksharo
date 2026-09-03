import { describe, expect, it, vi } from "vitest";

import { mixdownAndTranscribe, type HttpClient } from "./mixdown.js";
import { BridgeClient, MockBridgeTransport } from "../bridge/client.js";
import { MockAeHost } from "../host/ae.js";

function setup() {
  const transport = new MockBridgeTransport();
  const bridge = new BridgeClient(transport);
  const host = new MockAeHost();
  return { transport, bridge, host };
}

class RecordingHttpClient implements HttpClient {
  readonly puts: { url: string; body: Uint8Array; contentType: string }[] = [];
  readonly posts: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  postResult: unknown = { projectId: "proj-1", webEditorUrl: "https://aksharo.ai/p/proj-1" };

  async putBinary(url: string, body: Uint8Array, contentType: string): Promise<void> {
    this.puts.push({ url, body, contentType });
  }

  async postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
    this.posts.push({ url, body, headers });
    return this.postResult as T;
  }
}

describe("mixdownAndTranscribe", () => {
  it("mixes down, uploads, and creates a project, reporting every stage", async () => {
    const { transport, bridge, host } = setup();
    transport.on("media.uploadTicket", (params) => {
      expect(params).toEqual({ handle: "/tmp/mock-ae-mixdown-1.wav" });
      return { uploadUrl: "https://r2.example/put/1", expiresAt: "later" };
    });
    const http = new RecordingHttpClient();
    const stages: string[] = [];

    const result = await mixdownAndTranscribe({
      host,
      bridge,
      http,
      apiOrigin: "https://api.aksharo.ai",
      sessionToken: "sess-1",
      compId: "comp-mock-1",
      range: { startSeconds: 0, durationSeconds: 10 },
      format: "mono16k",
      project: {
        compName: "Mock Comp",
        languageHints: ["hi-Latn"],
        fps: 25,
        width: 1080,
        height: 1920,
      },
      onStageChange: (event) => stages.push(event.stage),
    });

    expect(result).toEqual({ projectId: "proj-1", webEditorUrl: "https://aksharo.ai/p/proj-1" });
    expect(stages).toEqual([
      "mixing",
      "mixing",
      "mixing",
      "mixing",
      "mixing",
      "uploading",
      "uploading",
      "creatingProject",
      "done",
    ]);

    expect(http.puts).toHaveLength(1);
    expect(http.puts[0]?.url).toBe("https://r2.example/put/1");
    expect(http.puts[0]?.contentType).toBe("audio/wav");

    expect(http.posts).toHaveLength(1);
    expect(http.posts[0]?.url).toBe("https://api.aksharo.ai/transcribe");
    expect(http.posts[0]?.headers).toEqual({ Authorization: "Bearer sess-1" });
    expect(http.posts[0]?.body).toMatchObject({
      source: "ae-cep",
      compName: "Mock Comp",
      languageHints: ["hi-Latn"],
      audioFormat: "mono16k",
    });
  });

  it("reports an error stage and rethrows when the upload ticket fails", async () => {
    const { transport, bridge, host } = setup();
    transport.on("media.uploadTicket", () => {
      throw new Error("no such handle");
    });
    const http = new RecordingHttpClient();
    const onStageChange = vi.fn();

    await expect(
      mixdownAndTranscribe({
        host,
        bridge,
        http,
        apiOrigin: "https://api.aksharo.ai",
        sessionToken: "sess-1",
        compId: "comp-mock-1",
        range: { startSeconds: 0, durationSeconds: 10 },
        format: "mono16k",
        project: { compName: "S", languageHints: [], fps: 25, width: 1080, height: 1920 },
        onStageChange,
      }),
    ).rejects.toThrow(/no such handle/);

    expect(onStageChange).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "error",
        message: expect.stringContaining("no such handle"),
      }),
    );
    expect(http.puts).toHaveLength(0);
  });

  it("uses the stereo48k content type and format for a cloud-clean request", async () => {
    const { transport, bridge, host } = setup();
    transport.on("media.uploadTicket", () => ({
      uploadUrl: "https://r2.example/put/2",
      expiresAt: "later",
    }));
    const http = new RecordingHttpClient();

    await mixdownAndTranscribe({
      host,
      bridge,
      http,
      apiOrigin: "https://api.aksharo.ai",
      sessionToken: "sess-1",
      compId: "comp-mock-1",
      range: { startSeconds: 0, durationSeconds: 10 },
      format: "stereo48k",
      project: { compName: "S", languageHints: [], fps: 25, width: 1080, height: 1920 },
    });

    expect(http.puts[0]?.contentType).toBe("audio/wav");
    expect(http.posts[0]?.body).toMatchObject({ audioFormat: "stereo48k" });
  });
});

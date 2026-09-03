import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditPlanInput } from "@montaj/prompts";

import {
  AnthropicPlannerClient,
  MockPlannerClient,
  OllamaPlannerClient,
} from "./planner-client.js";

const INPUT: EditPlanInput = {
  prompt: "cut the boring parts and add music",
  language: "en",
  durationMs: 60_000,
  existingStyles: [],
  planTier: "creator",
  segments: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_PLAN = {
  passes: [{ kind: "autocut", params: { preset: "standard", engine: "flash" } }],
  rationale: ["trims dead air"],
};

describe("MockPlannerClient", () => {
  it("returns a deterministic mock plan with no network", async () => {
    const client = new MockPlannerClient();
    const result = await client.generate(INPUT);
    expect(result.provider).toBe("mock");
    expect(result.output.passes.length).toBeGreaterThan(0);
  });
});

describe("OllamaPlannerClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts to the base URL's OpenAI-compatible chat endpoint with JSON mode", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OllamaPlannerClient("http://127.0.0.1:11434/v1", "qwen2.5:3b");
    const result = await client.generate(INPUT);

    expect(result.provider).toBe("ollama");
    expect(result.output.passes[0]?.kind).toBe("autocut");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("qwen2.5:3b");
    expect(body["response_format"]).toEqual({ type: "json_object" });
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OllamaPlannerClient("http://127.0.0.1:11434/v1/", "qwen2.5:3b");
    await client.generate(INPUT);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("retries once with a repair message on invalid JSON, then succeeds", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (): Promise<Response> => {
      call += 1;
      if (call === 1) {
        return jsonResponse({ choices: [{ message: { content: "not json" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OllamaPlannerClient("http://127.0.0.1:11434/v1", "qwen2.5:3b");
    const result = await client.generate(INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.output.passes[0]?.kind).toBe("autocut");
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string) as {
      messages: { role: string; content: string }[];
    };
    expect(secondBody.messages[1]?.content).toContain("<repair>");
  });

  it("throws when the repair attempt also fails schema validation", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ choices: [{ message: { content: "still not json" } }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OllamaPlannerClient("http://127.0.0.1:11434/v1", "qwen2.5:3b");
    await expect(client.generate(INPUT)).rejects.toThrow(/failed schema validation twice/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-2xx response", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => jsonResponse({ error: "boom" }, 503));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new OllamaPlannerClient("http://127.0.0.1:11434/v1", "qwen2.5:3b");
    await expect(client.generate(INPUT)).rejects.toThrow(/Ollama planner call failed: 503/);
  });
});

describe("AnthropicPlannerClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses the first text content block and validates it against the schema", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ content: [{ type: "text", text: JSON.stringify(VALID_PLAN) }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new AnthropicPlannerClient("sk-test");
    const result = await client.generate(INPUT);
    expect(result.provider).toBe("anthropic");
    expect(result.output.passes[0]?.kind).toBe("autocut");
  });

  it("retries once on invalid output, then throws if the repair also fails", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> =>
      jsonResponse({ content: [{ type: "text", text: "nope" }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new AnthropicPlannerClient("sk-test");
    await expect(client.generate(INPUT)).rejects.toThrow(/failed schema validation twice/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

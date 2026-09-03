import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateWithOllama,
  isOllamaReachable,
  ollamaBaseUrl,
  ollamaModel,
} from "./ollama-provider.js";
import { editPlanTemplate } from "../templates/edit-plan.js";

import type { EditPlanInput } from "../templates/edit-plan.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INPUT: EditPlanInput = {
  prompt: "cut the boring parts",
  language: "en",
  durationMs: 60_000,
  existingStyles: [],
  planTier: "creator",
  segments: [],
};

const VALID_PLAN = {
  passes: [{ kind: "autocut", params: { preset: "standard", engine: "flash" } }],
  rationale: ["trims dead air"],
};

describe("ollamaBaseUrl / ollamaModel", () => {
  const originalBaseUrl = process.env["LLM_BASE_URL"];
  const originalModel = process.env["LLM_MODEL"];

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env["LLM_BASE_URL"];
    else process.env["LLM_BASE_URL"] = originalBaseUrl;
    if (originalModel === undefined) delete process.env["LLM_MODEL"];
    else process.env["LLM_MODEL"] = originalModel;
  });

  it("defaults to the stock local Ollama install", () => {
    delete process.env["LLM_BASE_URL"];
    delete process.env["LLM_MODEL"];
    expect(ollamaBaseUrl()).toBe("http://127.0.0.1:11434/v1");
    expect(ollamaModel()).toBe("qwen2.5:3b");
  });

  it("reads the configured base URL and model, stripping a trailing slash", () => {
    process.env["LLM_BASE_URL"] = "http://127.0.0.1:22222/v1/";
    process.env["LLM_MODEL"] = "llama3.2:1b";
    expect(ollamaBaseUrl()).toBe("http://127.0.0.1:22222/v1");
    expect(ollamaModel()).toBe("llama3.2:1b");
  });
});

describe("isOllamaReachable", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("is true when the models endpoint responds ok", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    await expect(isOllamaReachable("http://127.0.0.1:11434/v1")).resolves.toBe(true);
  });

  it("is false when the fetch throws (nothing listening)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(isOllamaReachable("http://127.0.0.1:11434/v1")).resolves.toBe(false);
  });

  it("is false when the response is not ok", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    await expect(isOllamaReachable("http://127.0.0.1:11434/v1")).resolves.toBe(false);
  });
});

describe("generateWithOllama", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("validates the first reply against the template's schema and reports a latency", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }] }),
    ) as unknown as typeof fetch;

    const result = await generateWithOllama(editPlanTemplate, INPUT, {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:3b",
    });
    expect(result.output.passes[0]?.kind).toBe("autocut");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("retries once with a repair message, then throws if still invalid", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "not json" } }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      generateWithOllama(editPlanTemplate, INPUT, {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5:3b",
      }),
    ).rejects.toThrow(/failed schema validation twice/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

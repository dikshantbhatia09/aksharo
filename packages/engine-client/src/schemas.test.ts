import { describe, expect, it } from "vitest";

import {
  EngineDiscoveryFileSchema,
  HealthResponseSchema,
  ModelsResponseSchema,
  TranscribeStreamMessageSchema,
} from "./schemas.js";

describe("engine-client schemas", () => {
  it("accepts a well-formed health response", () => {
    const parsed = HealthResponseSchema.safeParse({
      status: "ok",
      backend: "cpu",
      tier: "C",
      tierReason: "4-8 cores/8GB, small model",
      engineVersions: { asr: "ggml-large-v3-turbo-q5_0" },
      modelsMissing: true,
      uptimeS: 42,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown backend kind", () => {
    const parsed = HealthResponseSchema.safeParse({
      status: "ok",
      backend: "quantum",
      tier: "A",
      tierReason: "x",
      engineVersions: {},
      modelsMissing: false,
      uptimeS: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("discriminates the three transcribe stream message kinds", () => {
    const partial = TranscribeStreamMessageSchema.safeParse({
      requestId: "r1",
      kind: "partial",
      words: [],
      segment: { start: 0, end: 1, text: "hi" },
    });
    expect(partial.success).toBe(true);

    const error = TranscribeStreamMessageSchema.safeParse({
      requestId: "r1",
      kind: "error",
      error: { code: "engine/backend_unavailable", message: "no model" },
    });
    expect(error.success).toBe(true);
  });

  it("requires a bearer of at least 32 chars in the discovery file", () => {
    const tooShort = EngineDiscoveryFileSchema.safeParse({
      port: 47900,
      bearer: "short",
      pid: 1,
      version: "0.1.0",
      startedAt: new Date().toISOString(),
    });
    expect(tooShort.success).toBe(false);
  });

  it("parses a models response with mixed model states", () => {
    const parsed = ModelsResponseSchema.safeParse({
      models: [
        {
          id: "ggml-large-v3-turbo-q5_0",
          kind: "asr",
          sizeBytes: 574_000_000,
          state: "available",
          sha256: "a".repeat(64),
          version: "1.0.0",
        },
      ],
      diskUsageBytes: 0,
      diskBudgetBytes: 5_000_000_000,
      defaultModel: "ggml-large-v3-turbo-q5_0",
      fallbackModel: "ggml-small-q5_1",
    });
    expect(parsed.success).toBe(true);
  });
});

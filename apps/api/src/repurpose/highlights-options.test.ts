import { describe, expect, it, vi } from "vitest";

import { discoveryModelOptions, discoveryModelOptionsFor } from "./highlights-options.js";

const caption = (outputLanguage: string, scriptMode: string): Record<string, unknown> => ({
  caption: { outputLanguage, scriptMode, styleId: "punch-pop", styleVersion: 1 },
});

describe("discoveryModelOptions", () => {
  it("writes a Hinglish run's copy in Hinglish, in the captions' script", () => {
    expect(discoveryModelOptions(caption("same", "roman"), "hi-Latn", "in")).toEqual({
      copy: { language: "hi-Latn", scriptMode: "roman" },
      region: "in",
    });
  });

  it("writes the copy in the captions' language when the run translates them", () => {
    expect(discoveryModelOptions(caption("en", "auto"), "hi-Latn", "in").copy).toEqual({
      language: "en",
      scriptMode: "auto",
    });
  });

  it("passes the steering form's topic on, trimmed, and drops one too short to mean anything", () => {
    const withTopic = { ...caption("same", "auto"), discovery: { topic: "  cricket  " } };
    expect(discoveryModelOptions(withTopic, "en", "in").topic).toBe("cricket");
    const tiny = { ...caption("same", "auto"), discovery: { topic: " x " } };
    expect(discoveryModelOptions(tiny, "en", "in")).not.toHaveProperty("topic");
    const long = { discovery: { topic: "a".repeat(500) } };
    expect(discoveryModelOptions(long, "en", "in").topic).toHaveLength(200);
  });

  it("reads a run from before any of this as the spoken language, auto script, India", () => {
    expect(discoveryModelOptions({}, "hi", undefined)).toEqual({
      copy: { language: "hi", scriptMode: "auto" },
      region: "in",
    });
    expect(discoveryModelOptions(null, "auto", null)).toEqual({
      copy: { language: "en", scriptMode: "auto" },
      region: "in",
    });
  });

  it("keeps the workspace's region, and refuses to invent one", () => {
    expect(discoveryModelOptions({}, "en", "eu").region).toBe("eu");
    expect(discoveryModelOptions({}, "en", "us").region).toBe("us");
    expect(discoveryModelOptions({}, "en", "mars").region).toBe("in");
  });

  it("ignores a script mode it does not know", () => {
    expect(discoveryModelOptions(caption("same", "cursive"), "hi", "in").copy?.scriptMode).toBe(
      "auto",
    );
  });
});

describe("discoveryModelOptionsFor", () => {
  it("reads the region from the run's workspace", async () => {
    const findUnique = vi.fn(async () => ({ region: "eu" }));
    const options = await discoveryModelOptionsFor(
      { workspace: { findUnique } } as never,
      { workspaceId: "WS", config: {} },
      "en",
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "WS" }, select: { region: true } });
    expect(options.region).toBe("eu");
  });
});

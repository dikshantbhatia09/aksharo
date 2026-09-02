import { describe, expect, it } from "vitest";

import { createConsentStore, type ConsentFileIO } from "./consent-store.js";

function memoryIO(): ConsentFileIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readText: (path) => files.get(path),
    writeText: (path, content) => {
      files.set(path, content);
    },
  };
}

describe("createConsentStore", () => {
  it("starts undecided and not granted", () => {
    const store = createConsentStore("/consent.json", memoryIO());
    expect(store.get()).toEqual({ granted: false });
    expect(store.hasDecided()).toBe(false);
  });

  it("records a grant with a timestamp", () => {
    const store = createConsentStore("/consent.json", memoryIO());
    const at = new Date("2026-09-02T10:00:00.000Z");
    const state = store.set(true, at);
    expect(state).toEqual({ granted: true, decidedAt: at.toISOString() });
    expect(store.get()).toEqual(state);
    expect(store.hasDecided()).toBe(true);
  });

  it("records a refusal (decided, not granted)", () => {
    const store = createConsentStore("/consent.json", memoryIO());
    store.set(false);
    expect(store.get().granted).toBe(false);
    expect(store.hasDecided()).toBe(true);
  });

  it("recovers from a corrupt file", () => {
    const io = memoryIO();
    io.files.set("/consent.json", "not json");
    const store = createConsentStore("/consent.json", io);
    expect(store.get()).toEqual({ granted: false });
  });

  it("persists across a fresh store instance against the same file", () => {
    const io = memoryIO();
    createConsentStore("/consent.json", io).set(true);
    const second = createConsentStore("/consent.json", io);
    expect(second.get().granted).toBe(true);
  });
});

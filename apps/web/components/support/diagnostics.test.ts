import { afterEach, describe, expect, it, vi } from "vitest";

import { installConsoleErrorRingBuffer, recentConsoleErrors } from "./diagnostics";

describe("console-error ring buffer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures console.error calls, capped at 20", () => {
    installConsoleErrorRingBuffer();
    for (let i = 0; i < 25; i += 1) console.error(`boom ${i}`);
    const errors = recentConsoleErrors();
    expect(errors.length).toBeLessThanOrEqual(20);
    expect(errors.at(-1)).toContain("boom 24");
  });
});

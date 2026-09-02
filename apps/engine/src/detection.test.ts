import { describe, expect, it } from "vitest";

import { detectBackend, type SystemInfo } from "./detection.js";

function info(overrides: Partial<SystemInfo>): SystemInfo {
  return { platform: "win32", cores: 8, ramGb: 16, ...overrides };
}

describe("detectBackend", () => {
  it("tier D and cpu when RAM is under 8GB regardless of platform", () => {
    const result = detectBackend(info({ ramGb: 4, hasVulkan: true }));
    expect(result.tier).toBe("D");
  });

  it("tier A and metal-coreml on Apple Silicon with >=16GB", () => {
    const result = detectBackend(info({ platform: "darwin", hasMetal: true, ramGb: 16, cores: 8 }));
    expect(result.tier).toBe("A");
    expect(result.backend).toBe("metal-coreml");
  });

  it("still reports metal-coreml on a low-RAM Mac, but tier drops below A", () => {
    const result = detectBackend(info({ platform: "darwin", hasMetal: true, ramGb: 8, cores: 4 }));
    expect(result.backend).toBe("metal-coreml");
    expect(result.tier).not.toBe("A");
  });

  it("tier B on Windows with >=8 cores, >=16GB and a GPU", () => {
    const result = detectBackend(info({ platform: "win32", cores: 8, ramGb: 16, hasVulkan: true }));
    expect(result.tier).toBe("B");
    expect(result.backend).toBe("vulkan");
  });

  it("prefers cuda over vulkan when both are reported", () => {
    const result = detectBackend(info({ hasVulkan: true, hasCuda: true }));
    expect(result.backend).toBe("cuda");
  });

  it("tier C on modest hardware (4-8 cores, 8GB) with no GPU", () => {
    const result = detectBackend(info({ platform: "win32", cores: 4, ramGb: 8, hasVulkan: false, hasCuda: false }));
    expect(result.tier).toBe("C");
    expect(result.backend).toBe("cpu");
  });

  it("falls back to cpu when no GPU flag is set", () => {
    const result = detectBackend(info({ platform: "linux", cores: 8, ramGb: 16 }));
    expect(result.backend).toBe("cpu");
  });

  it("tier D below the C floor (fewer than 4 cores)", () => {
    const result = detectBackend(info({ platform: "linux", cores: 2, ramGb: 8 }));
    expect(result.tier).toBe("D");
  });
});

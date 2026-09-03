import { describe, expect, it } from "vitest";

import { ENGINE_PRESETS, engineParamsFor } from "./engines.js";

describe("engine presets (D07 §2)", () => {
  it("flash is VAD-only cut, 540p tracking, cached picks, no ASR re-pass", () => {
    const flash = ENGINE_PRESETS.flash;
    expect(flash.autocut.strategy).toBe("vad_only");
    expect(flash.autocut.cachedPicks).toBe(true);
    expect(flash.tracking.resolution).toBe("540p");
    expect(flash.asr.repassModel).toBeNull();
  });

  it("pro is LLM-re-ranked cuts, full-res tracking, an ASR re-pass model", () => {
    const pro = ENGINE_PRESETS.pro;
    expect(pro.autocut.strategy).toBe("llm_reranked");
    expect(pro.autocut.cachedPicks).toBe(false);
    expect(pro.tracking.resolution).toBe("full_res");
    expect(pro.asr.repassModel).not.toBeNull();
  });

  it("engineParamsFor defaults an undefined tier to flash", () => {
    expect(engineParamsFor(undefined)).toBe(ENGINE_PRESETS.flash);
    expect(engineParamsFor("pro")).toBe(ENGINE_PRESETS.pro);
  });
});
